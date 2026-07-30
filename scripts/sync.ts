/**
 * Pushes agent prompts and knowledge base content from this repo to ElevenLabs.
 *
 * The repo is the source of truth; ElevenLabs is a deploy target. Run:
 *   npm run sync:dry   # show what would change
 *   npm run sync
 *
 * Agent IDs are recorded in agents/ids.json and committed, so repeated runs
 * update in place rather than creating duplicates.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ElevenLabsClient } from "./elevenlabs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(ROOT, "agents");
const KB_DIR = join(ROOT, "kb");
const IDS_PATH = join(AGENTS_DIR, "ids.json");

const DRY_RUN = process.argv.includes("--dry-run");
const TOOLS_BASE_URL = process.env.TOOLS_BASE_URL ?? "";

/** Name of the workspace secret holding AGENT_TOOL_SECRET. */
const SECRET_NAME = process.env.ELEVENLABS_SECRET_NAME ?? "agent_tool_secret";
const AGENT_TIMEZONE = process.env.AGENT_TIMEZONE ?? "America/Los_Angeles";
const DEFAULT_LLM = "claude-sonnet-5";

interface Frontmatter {
  slug: string;
  name: string;
  llm?: string;
  temperature?: number;
  max_duration_seconds?: number;
  first_message?: string | null;
  tools?: string[];
  transfers?: string[];
  knowledge_base?: string[];
}

interface AgentDefinition {
  frontmatter: Frontmatter;
  systemPrompt: string;
}

interface IdMap {
  agents: Record<string, string>;
  tools: Record<string, string>;
  knowledgeBase: Record<string, { id: string; hash: string }>;
}

function splitFrontmatter(source: string): { data: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error("missing frontmatter block");
  return { data: parseYaml(match[1] ?? ""), body: (match[2] ?? "").trim() };
}

async function loadAgents(): Promise<AgentDefinition[]> {
  const files = (await readdir(AGENTS_DIR)).filter((file) => file.endsWith(".md"));
  const definitions: AgentDefinition[] = [];

  for (const file of files.sort()) {
    const source = await readFile(join(AGENTS_DIR, file), "utf8");
    const { data, body } = splitFrontmatter(source);
    const frontmatter = data as Frontmatter;

    if (!frontmatter?.slug || !frontmatter?.name) {
      throw new Error(`${file}: frontmatter needs both 'slug' and 'name'`);
    }
    if (!body) throw new Error(`${file}: system prompt body is empty`);

    definitions.push({ frontmatter, systemPrompt: body });
  }

  return definitions;
}

/** Concatenates kb/<collection>/*.md into one document per collection. */
async function loadKnowledgeBase(): Promise<Map<string, string>> {
  const collections = new Map<string, string>();
  if (!existsSync(KB_DIR)) return collections;

  for (const entry of await readdir(KB_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = join(KB_DIR, entry.name);
    const files = (await readdir(dir))
      .filter((file) => file.endsWith(".md") && file !== "README.md")
      .sort();

    const parts: string[] = [];
    for (const file of files) {
      parts.push((await readFile(join(dir, file), "utf8")).trim());
    }

    const text = parts.filter(Boolean).join("\n\n---\n\n");
    if (text) collections.set(entry.name, text);
  }

  return collections;
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function loadIds(): Promise<IdMap> {
  if (!existsSync(IDS_PATH)) return { agents: {}, tools: {}, knowledgeBase: {} };
  const parsed = JSON.parse(await readFile(IDS_PATH, "utf8")) as Partial<IdMap>;
  return {
    agents: parsed.agents ?? {},
    tools: parsed.tools ?? {},
    knowledgeBase: parsed.knowledgeBase ?? {},
  };
}

async function saveIds(ids: IdMap): Promise<void> {
  await writeFile(IDS_PATH, `${JSON.stringify(ids, null, 2)}\n`);
}

/**
 * Webhook tool definitions.
 *
 * Two things here are easy to get wrong and fail silently:
 *
 * - `request_headers` values are not template strings. A secret is referenced
 *   as `{secret_id: "..."}`, using the secret's ID rather than its name — a
 *   plain "{{secret__name}}" string is sent to the worker literally, and every
 *   tool call comes back 401.
 * - System values like the caller's number are wired with `dynamic_variable`,
 *   not `constant_value`. `constant_value` is a literal, so the same string
 *   would arrive on every call.
 */
function toolDefinitions(secretId: string): Record<string, unknown> {
  if (!TOOLS_BASE_URL) {
    throw new Error("TOOLS_BASE_URL must be set to configure webhook tools");
  }

  const requestHeaders = { "X-Agent-Secret": { secret_id: secretId } };

  return {
    verify_passcode: {
      type: "webhook",
      name: "verify_passcode",
      description:
        "Check a caller-supplied passphrase. Returns whether it is valid, how many attempts remain, and whether the caller is locked out. This is the only way to check the passphrase.",
      response_timeout_secs: 10,
      api_schema: {
        url: `${TOOLS_BASE_URL}/tools/verify-passcode`,
        method: "POST",
        request_headers: requestHeaders,
        request_body_schema: {
          type: "object",
          required: ["passcode"],
          properties: {
            passcode: {
              type: "string",
              description: "Exactly what the caller said, verbatim.",
            },
            caller_id: {
              type: "string",
              description: "The caller's phone number.",
              dynamic_variable: "system__caller_id",
            },
          },
        },
      },
    },
    submit_opportunity: {
      type: "webhook",
      name: "submit_opportunity",
      description:
        "Record an inbound opportunity and get a verdict on whether it fits. Call once you have most of the details. Leave a field out if it was not discussed — never guess.",
      response_timeout_secs: 15,
      api_schema: {
        url: `${TOOLS_BASE_URL}/tools/submit-opportunity`,
        method: "POST",
        request_headers: requestHeaders,
        request_body_schema: {
          type: "object",
          required: [],
          properties: {
            caller_name: { type: "string", description: "Caller's name." },
            company: { type: "string", description: "Hiring company." },
            role: { type: "string", description: "Role title and what the work is." },
            compensation: {
              type: "string",
              description: "Comp as stated, verbatim. Do not convert or estimate.",
            },
            location: { type: "string", description: "Where the role is based." },
            work_mode: { type: "string", description: "remote, hybrid, or onsite." },
            company_stage: { type: "string", description: "Stage or headcount." },
            contact: { type: "string", description: "Email or phone." },
            notes: { type: "string", description: "Anything else worth passing on." },
            conversation_id: {
              type: "string",
              description: "Conversation identifier.",
              dynamic_variable: "system__conversation_id",
            },
          },
        },
      },
    },
  };
}

/**
 * Transfers are configured as a built-in system tool rather than an entry in
 * the tools list.
 */
function buildTransferTool(targets: { slug: string; agentId: string }[]): unknown {
  return {
    name: "transfer_to_agent",
    params: {
      system_tool_type: "transfer_to_agent",
      transfers: targets.map((target) => ({
        agent_id: target.agentId,
        condition: `The caller should be handled by the ${target.slug} agent.`,
        // The specialists have no first message; they pick up mid-conversation.
        enable_transferred_agent_first_message: false,
      })),
    },
  };
}

function buildConversationConfig(
  definition: AgentDefinition,
  knowledgeBaseIds: { id: string; name: string }[],
  toolIds: string[],
  transferTool: unknown | null,
): unknown {
  const { frontmatter, systemPrompt } = definition;

  return {
    agent: {
      language: "en",
      first_message: frontmatter.first_message ?? "",
      prompt: {
        prompt: systemPrompt,
        llm: frontmatter.llm ?? DEFAULT_LLM,
        temperature: frontmatter.temperature ?? 0.3,
        tool_ids: toolIds,
        ...(transferTool
          ? { built_in_tools: { transfer_to_agent: transferTool } }
          : {}),
        knowledge_base: knowledgeBaseIds.map((entry) => ({
          type: "text",
          id: entry.id,
          name: entry.name,
        })),
        // Without a timezone the agent has no idea what today's date is, and
        // will do arithmetic on the dates in the knowledge base anyway —
        // inventing tenures and "he's been there for X years". Costa Mesa.
        timezone: AGENT_TIMEZONE,
        // Small corpus: the whole document set fits in context, and retrieval
        // over a few thousand tokens mostly adds a way to miss the right chunk.
        // Flip to true once kb/ outgrows the context window.
        rag: { enabled: false },
      },
    },
    tts: {
      voice_id: process.env.ELEVENLABS_VOICE_ID || undefined,
    },
    conversation: {
      max_duration_seconds: frontmatter.max_duration_seconds ?? 600,
    },
  };
}

/**
 * Creates or updates the webhook tools and returns name → tool ID.
 *
 * Inline tool definitions on the agent are deprecated in favour of tool_ids,
 * so tools are first-class objects with their own lifecycle.
 */
async function syncTools(
  client: ElevenLabsClient | null,
  ids: IdMap,
  secretId: string,
): Promise<Record<string, string>> {
  const definitions = toolDefinitions(secretId);
  const resolved: Record<string, string> = {};

  for (const [name, config] of Object.entries(definitions)) {
    const existingId = ids.tools[name];
    console.log(`  ${name}: ${existingId ? `update (${existingId})` : "create"}`);

    if (DRY_RUN || !client) {
      resolved[name] = existingId ?? `dry-run-${name}`;
      continue;
    }

    if (existingId) {
      await client.updateTool(existingId, config);
      resolved[name] = existingId;
    } else {
      const created = await client.createTool(config);
      resolved[name] = created.id;
      ids.tools[name] = created.id;
    }
  }

  return resolved;
}

/**
 * Resolves the workspace secret name into the ID the tool headers need.
 *
 * The secret must already exist — it is created in the dashboard so its value
 * never passes through this repo.
 */
async function resolveSecretId(client: ElevenLabsClient | null): Promise<string> {
  if (DRY_RUN || !client) return "dry-run-secret-id";

  const { secrets } = await client.listSecrets();
  const match = secrets?.find((secret) => secret.name === SECRET_NAME);

  if (!match) {
    const available = secrets?.map((secret) => secret.name).join(", ") || "none";
    throw new Error(
      `no workspace secret named '${SECRET_NAME}'. Create it in the ElevenLabs ` +
        `dashboard with the same value as AGENT_TOOL_SECRET, then re-run. ` +
        `Existing secrets: ${available}`,
    );
  }

  return match.secret_id;
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  if (!DRY_RUN && !apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  if (!process.env.ELEVENLABS_VOICE_ID) {
    console.warn("! ELEVENLABS_VOICE_ID is not set — agents will use the account default voice\n");
  }

  const client = DRY_RUN ? null : new ElevenLabsClient(apiKey);
  const definitions = await loadAgents();
  const collections = await loadKnowledgeBase();
  const ids = await loadIds();

  // ── Knowledge base ──────────────────────────────────────────────────────
  // Content-hashed: unchanged collections are left alone. ElevenLabs text
  // documents are immutable, so a change means upload-new then delete-old.
  const documents = new Map<string, { id: string; name: string }>();

  for (const [collection, text] of collections) {
    const digest = await hash(text);
    const existing = ids.knowledgeBase[collection];
    const name = `kb-${collection}`;

    if (existing && existing.hash === digest) {
      console.log(`  kb/${collection}: unchanged`);
      documents.set(collection, { id: existing.id, name });
      continue;
    }

    console.log(`  kb/${collection}: ${existing ? "changed" : "new"} (${text.length} chars)`);
    if (DRY_RUN || !client) {
      documents.set(collection, { id: `dry-run-${collection}`, name });
      continue;
    }

    const created = await client.createKnowledgeBaseText(name, text);
    documents.set(collection, { id: created.id, name });
    ids.knowledgeBase[collection] = { id: created.id, hash: digest };

    if (existing) {
      await client
        .deleteKnowledgeBaseDocument(existing.id)
        .catch((error) => console.warn(`    could not delete old document: ${error.message}`));
    }
  }

  for (const collection of Object.keys(ids.knowledgeBase)) {
    if (!collections.has(collection)) {
      console.warn(`  kb/${collection}: directory gone; leaving the remote document in place`);
    }
  }

  // ── Tools ───────────────────────────────────────────────────────────────
  console.log("\nTools:");
  const secretId = await resolveSecretId(client);
  const toolIds = await syncTools(client, ids, secretId);

  // ── Agents, pass 1: create or update without transfers ──────────────────
  // Transfer targets are agent IDs, which do not exist until every agent does.
  console.log("\nAgents:");

  const resolveKb = (definition: AgentDefinition, warn: boolean) =>
    (definition.frontmatter.knowledge_base ?? [])
      .map((collection) => {
        const document = documents.get(collection);
        if (!document && warn) {
          console.warn(
            `  ${definition.frontmatter.slug}: kb/${collection} referenced but empty or missing`,
          );
        }
        return document;
      })
      .filter((entry): entry is { id: string; name: string } => Boolean(entry));

  const resolveToolIds = (definition: AgentDefinition) =>
    (definition.frontmatter.tools ?? []).map((name) => {
      const id = toolIds[name];
      if (!id) throw new Error(`${definition.frontmatter.slug}: unknown tool '${name}'`);
      return id;
    });

  for (const definition of definitions) {
    const { slug, name } = definition.frontmatter;
    const kbIds = resolveKb(definition, true);
    const config = buildConversationConfig(definition, kbIds, resolveToolIds(definition), null);
    const existingId = ids.agents[slug];

    console.log(`  ${slug}: ${existingId ? `update (${existingId})` : "create"}`);
    if (DRY_RUN || !client) {
      ids.agents[slug] ??= `dry-run-${slug}`;
      continue;
    }

    if (existingId) {
      await client.updateAgent(existingId, { name, conversation_config: config });
    } else {
      const created = await client.createAgent({
        name,
        tags: ["daehan-voice-agent"],
        conversation_config: config,
      });
      ids.agents[slug] = created.agent_id;
    }
  }

  // ── Agents, pass 2: attach transfers ────────────────────────────────────
  for (const definition of definitions) {
    const { slug, transfers } = definition.frontmatter;
    if (!transfers?.length) continue;

    const targets = transfers.map((target) => {
      const agentId = ids.agents[target];
      if (!agentId) throw new Error(`${slug}: transfer target '${target}' has no agent`);
      return { slug: target, agentId };
    });

    console.log(`  ${slug}: transfers → ${targets.map((t) => t.slug).join(", ")}`);
    if (DRY_RUN || !client) continue;

    await client.updateAgent(ids.agents[slug]!, {
      name: definition.frontmatter.name,
      conversation_config: buildConversationConfig(
        definition,
        resolveKb(definition, false),
        resolveToolIds(definition),
        buildTransferTool(targets),
      ),
    });
  }

  if (!DRY_RUN) await saveIds(ids);
  console.log(DRY_RUN ? "\nDry run — nothing was sent." : "\nSynced. Commit agents/ids.json.");
}

main().catch((error) => {
  console.error(`\nsync failed: ${error.message}`);
  process.exit(1);
});
