/**
 * Runs evals/cases.yaml against the live agents using ElevenLabs' conversation
 * simulation API — no phone calls, no minutes billed against telephony.
 *
 *   npm run eval                 # everything
 *   npm run eval -- receptionist # one agent
 *
 * Exits non-zero on any failure so this can gate a deploy.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ElevenLabsClient } from "./elevenlabs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Case {
  id: string;
  agent: string;
  persona: string;
  expect_contains?: string[];
  expect_absent?: string[];
  expect_tool?: string;
  max_turns?: number;
}

interface Turn {
  role: string;
  message?: string;
  tool_calls?: { tool_name?: string; name?: string }[];
}

interface Result {
  id: string;
  passed: boolean;
  failures: string[];
}

function agentTranscript(turns: Turn[]): string {
  return turns
    .filter((turn) => turn.role !== "user")
    .map((turn) => turn.message ?? "")
    .join("\n")
    .toLowerCase();
}

function toolsCalled(turns: Turn[]): Set<string> {
  const called = new Set<string>();
  for (const turn of turns) {
    for (const call of turn.tool_calls ?? []) {
      const name = call.tool_name ?? call.name;
      if (name) called.add(name);
    }
  }
  return called;
}

function check(testCase: Case, turns: Turn[]): Result {
  const transcript = agentTranscript(turns);
  const tools = toolsCalled(turns);
  const failures: string[] = [];

  for (const forbidden of testCase.expect_absent ?? []) {
    if (transcript.includes(forbidden.toLowerCase())) {
      failures.push(`leaked ${JSON.stringify(forbidden)}`);
    }
  }

  const wanted = testCase.expect_contains ?? [];
  if (wanted.length > 0) {
    const hit = wanted.some((needle) => transcript.includes(needle.toLowerCase()));
    if (!hit) failures.push(`none of ${JSON.stringify(wanted)} appeared`);
  }

  if (testCase.expect_tool && !tools.has(testCase.expect_tool)) {
    failures.push(
      `expected tool ${testCase.expect_tool}, saw ${tools.size ? [...tools].join(", ") : "none"}`,
    );
  }

  return { id: testCase.id, passed: failures.length === 0, failures };
}

async function main() {
  const filter = process.argv[2];
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const client = new ElevenLabsClient(apiKey);

  const cases = parseYaml(
    await readFile(join(ROOT, "evals", "cases.yaml"), "utf8"),
  ) as Case[];
  const ids = JSON.parse(
    await readFile(join(ROOT, "agents", "ids.json"), "utf8"),
  ) as { agents: Record<string, string> };

  const selected = filter ? cases.filter((c) => c.agent === filter || c.id === filter) : cases;
  if (selected.length === 0) {
    console.error(`no cases matched ${JSON.stringify(filter)}`);
    process.exit(1);
  }

  const results: Result[] = [];

  for (const testCase of selected) {
    const agentId = ids.agents[testCase.agent];
    if (!agentId) {
      results.push({
        id: testCase.id,
        passed: false,
        failures: [`agent '${testCase.agent}' not in agents/ids.json — run sync first`],
      });
      continue;
    }

    try {
      const response = await client.simulateConversation(agentId, {
        simulation_specification: {
          simulated_user_config: { prompt: { prompt: testCase.persona } },
        },
        new_turns_limit: testCase.max_turns ?? 8,
      });
      results.push(check(testCase, response.simulated_conversation as Turn[]));
    } catch (error) {
      results.push({
        id: testCase.id,
        passed: false,
        failures: [`simulation error: ${(error as Error).message}`],
      });
    }
  }

  console.log("");
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.id}`);
    for (const failure of result.failures) console.log(`        ${failure}`);
  }

  const failed = results.filter((result) => !result.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`\neval failed: ${error.message}`);
  process.exit(1);
});
