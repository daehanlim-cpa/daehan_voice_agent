/**
 * Verifies scripts/elevenlabs.ts against ElevenLabs' published OpenAPI spec,
 * offline.
 *
 *   curl -o el-openapi.json https://api.elevenlabs.io/openapi.json
 *   npm run check-spec el-openapi.json
 *
 * The spec is public and needs no API key, so this validates every path and
 * payload shape without a live call, a credential, or network access. For each
 * endpoint the client uses it reports whether the path exists, whether the
 * method is allowed, and what the request body actually requires — and when a
 * path is missing, suggests the closest real ones.
 */
import { readFileSync } from "node:fs";

interface Endpoint {
  /** Function name in scripts/elevenlabs.ts */
  fn: string;
  method: string;
  /** `{...}` segments are treated as wildcards when matching the spec. */
  path: string;
  critical: boolean;
}

const ENDPOINTS: Endpoint[] = [
  { fn: "getUser", method: "get", path: "/v1/user", critical: false },
  { fn: "listAgents", method: "get", path: "/v1/convai/agents", critical: false },
  { fn: "createAgent", method: "post", path: "/v1/convai/agents/create", critical: true },
  { fn: "updateAgent", method: "patch", path: "/v1/convai/agents/{agent_id}", critical: true },
  { fn: "deleteAgent", method: "delete", path: "/v1/convai/agents/{agent_id}", critical: false },
  {
    fn: "createKnowledgeBaseText",
    method: "post",
    path: "/v1/convai/knowledge-base/text",
    critical: true,
  },
  {
    fn: "deleteKnowledgeBaseDocument",
    method: "delete",
    path: "/v1/convai/knowledge-base/{documentation_id}",
    critical: false,
  },
  { fn: "listKnowledgeBase", method: "get", path: "/v1/convai/knowledge-base", critical: false },
  { fn: "getVoice", method: "get", path: "/v1/voices/{voice_id}", critical: false },
  { fn: "listPhoneNumbers", method: "get", path: "/v1/convai/phone-numbers", critical: false },
  {
    fn: "simulateConversation",
    method: "post",
    path: "/v1/convai/agents/{agent_id}/simulate-conversation",
    critical: false,
  },
];

type Json = Record<string, any>;

/** Compares paths structurally so `{agent_id}` matches `{id}`. */
function normalize(path: string): string {
  return path.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "");
}

function similarity(a: string, b: string): number {
  const aParts = normalize(a).split("/").filter(Boolean);
  const bParts = normalize(b).split("/").filter(Boolean);
  const shared = aParts.filter((part) => bParts.includes(part)).length;
  return shared / Math.max(aParts.length, bParts.length, 1);
}

function resolveRef(spec: Json, ref: string): Json | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let node: any = spec;
  for (const part of parts) {
    node = node?.[part];
    if (!node) return null;
  }
  return node;
}

/** Follows $ref chains and allOf so the caller sees real properties. */
function flatten(spec: Json, schema: Json | null, depth = 0): Json | null {
  if (!schema || depth > 6) return schema;
  if (schema.$ref) return flatten(spec, resolveRef(spec, schema.$ref), depth + 1);
  if (Array.isArray(schema.allOf)) {
    const merged: Json = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const resolved = flatten(spec, part, depth + 1);
      Object.assign(merged.properties, resolved?.properties ?? {});
      merged.required.push(...(resolved?.required ?? []));
    }
    return merged;
  }
  return schema;
}

function describeBody(spec: Json, operation: Json): string[] {
  const content = operation?.requestBody?.content;
  if (!content) return [];

  const media =
    content["application/json"] ?? content[Object.keys(content)[0] ?? ""] ?? null;
  const schema = flatten(spec, media?.schema ?? null);
  if (!schema?.properties) return [];

  const required = new Set<string>(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, raw]) => {
    const prop = flatten(spec, raw as Json) ?? {};
    const type = prop.type ?? (prop.anyOf ? "anyOf" : prop.oneOf ? "oneOf" : "object");
    return `${required.has(name) ? "*" : " "} ${name}: ${type}`;
  });
}

function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error(
      "usage: npm run check-spec <path-to-openapi.json>\n\n" +
        "  curl -o el-openapi.json https://api.elevenlabs.io/openapi.json",
    );
    process.exit(1);
  }

  let spec: Json;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    console.error(`could not read spec: ${(error as Error).message}`);
    process.exit(1);
  }

  const paths: Json = spec.paths ?? {};
  const specPaths = Object.keys(paths);
  console.log(
    `\nSpec: ${specPaths.length} paths, version ${spec.info?.version ?? "unknown"}\n`,
  );

  const broken: string[] = [];

  for (const endpoint of ENDPOINTS) {
    const match = specPaths.find(
      (candidate) => normalize(candidate) === normalize(endpoint.path),
    );
    const label = `${endpoint.method.toUpperCase()} ${endpoint.path}`;

    if (!match) {
      console.log(`FAIL  ${endpoint.fn}`);
      console.log(`      ${label}`);
      console.log(`      path not in spec. Closest matches:`);
      for (const suggestion of specPaths
        .map((candidate) => ({ candidate, score: similarity(endpoint.path, candidate) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)) {
        const methods = Object.keys(paths[suggestion.candidate] ?? {})
          .filter((key) => !key.startsWith("x-") && key !== "parameters")
          .join("/");
        console.log(`        ${suggestion.candidate}  [${methods}]`);
      }
      console.log("");
      broken.push(`${endpoint.fn}: no such path ${endpoint.path}`);
      continue;
    }

    const operation = paths[match]?.[endpoint.method];
    if (!operation) {
      const available = Object.keys(paths[match] ?? {})
        .filter((key) => !key.startsWith("x-") && key !== "parameters")
        .join(", ");
      console.log(`FAIL  ${endpoint.fn}`);
      console.log(`      ${label}`);
      console.log(`      path exists but method not allowed. Available: ${available}\n`);
      broken.push(`${endpoint.fn}: ${endpoint.method.toUpperCase()} not allowed on ${match}`);
      continue;
    }

    console.log(`OK    ${endpoint.fn}  —  ${endpoint.method.toUpperCase()} ${match}`);

    if (endpoint.critical) {
      const fields = describeBody(spec, operation);
      if (fields.length > 0) {
        console.log(`      request body (* = required):`);
        for (const field of fields) console.log(`        ${field}`);
      }
    }
    console.log("");
  }

  if (broken.length > 0) {
    console.log(`${broken.length} endpoint(s) need fixing in scripts/elevenlabs.ts:`);
    for (const problem of broken) console.log(`  - ${problem}`);
    process.exit(1);
  }

  console.log("All endpoints match the spec.");
}

main();
