/**
 * Probes every ElevenLabs endpoint this repo depends on and reports which ones
 * actually work.
 *
 * The API layer in scripts/elevenlabs.ts was written without network access to
 * api.elevenlabs.io, so some paths and payload shapes are educated guesses.
 * This turns "run sync and see what 404s" into one command that tells you
 * exactly what to fix, before anything is created.
 *
 *   npm run preflight           # read-only probes
 *   npm run preflight -- --write  # also create and delete a throwaway agent
 *
 * The --write pass is the one that actually validates the create payload. It
 * cleans up after itself, and names everything "preflight-temp-*" so leftovers
 * from a crashed run are obvious in the dashboard.
 */
import { ElevenLabsClient, ElevenLabsError } from "./elevenlabs.js";

const WRITE = process.argv.includes("--write");

interface Probe {
  name: string;
  detail: string;
  run: () => Promise<string>;
}

const results: { name: string; ok: boolean; note: string }[] = [];

async function probe(entry: Probe): Promise<boolean> {
  process.stdout.write(`  ${entry.name.padEnd(34)}`);
  try {
    const note = await entry.run();
    console.log(`OK    ${note}`);
    results.push({ name: entry.name, ok: true, note });
    return true;
  } catch (error) {
    const note =
      error instanceof ElevenLabsError
        ? `HTTP ${error.status} on ${error.path}`
        : (error as Error).message;
    console.log(`FAIL  ${note}`);
    console.log(`        ${entry.detail}`);

    // The response body is the whole diagnostic on a 422 — it names the field
    // that's wrong. Printing only the status throws that away.
    if (error instanceof ElevenLabsError && error.body) {
      const body = error.body.length > 1200 ? `${error.body.slice(0, 1200)}…` : error.body;
      console.log(`        response: ${body.replace(/\n/g, "\n        ")}`);
    }

    results.push({ name: entry.name, ok: false, note });
    return false;
  }
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  if (!apiKey) {
    console.error("ELEVENLABS_API_KEY is not set. Put it in .env and re-run.");
    process.exit(1);
  }

  const client = new ElevenLabsClient(apiKey);
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "";

  console.log("\nRead-only probes:");

  const authOk = await probe({
    name: "auth (GET /v1/user)",
    detail: "The API key is rejected. Check it was copied whole and has Agents access.",
    run: async () => {
      const user = await client.getUser();
      return `tier: ${user.subscription?.tier ?? "unknown"}`;
    },
  });

  if (!authOk) {
    console.log("\nAuth failed — skipping the rest, they will all fail the same way.\n");
    process.exit(1);
  }

  await probe({
    name: "list agents",
    detail:
      "Path is likely wrong. Find the list-agents endpoint in the docs and fix listAgents() in scripts/elevenlabs.ts.",
    run: async () => {
      const { agents } = await client.listAgents();
      return `${agents?.length ?? 0} existing`;
    },
  });

  await probe({
    name: "list knowledge base",
    detail:
      "Path is likely wrong. Fix listKnowledgeBase() and check createKnowledgeBaseText() against the same docs page.",
    run: async () => {
      const { documents } = await client.listKnowledgeBase();
      return `${documents?.length ?? 0} existing`;
    },
  });

  await probe({
    name: "list phone numbers",
    detail:
      "Only matters at the telephony step. Safe to ignore until then.",
    run: async () => {
      const numbers = await client.listPhoneNumbers();
      return `${Array.isArray(numbers) ? numbers.length : 0} configured`;
    },
  });

  if (voiceId) {
    await probe({
      name: "voice clone resolves",
      detail: "ELEVENLABS_VOICE_ID does not resolve. Copy the ID from the dashboard voice page.",
      run: async () => {
        const voice = await client.getVoice(voiceId);
        return voice.name;
      },
    });
  } else {
    console.log(`  ${"voice clone resolves".padEnd(34)}SKIP  ELEVENLABS_VOICE_ID not set yet`);
  }

  if (!WRITE) {
    console.log("\nSkipping write probes. Re-run with --write to validate the create payload.");
  } else {
    console.log("\nWrite probes (throwaway objects, deleted afterwards):");

    let tempAgentId: string | null = null;

    await probe({
      name: "create agent",
      detail:
        "This is the important one: the conversation_config shape in sync.ts is wrong. Compare the error body against the create-agent docs and fix buildConversationConfig().",
      run: async () => {
        const created = await client.createAgent({
          name: "preflight-temp-agent",
          tags: ["preflight-temp"],
          conversation_config: {
            agent: {
              language: "en",
              first_message: "Preflight check.",
              prompt: {
                prompt: "You are a temporary agent created by a preflight check.",
                llm: process.env.PREFLIGHT_LLM || "claude-sonnet-4-5",
                temperature: 0.3,
              },
            },
            ...(voiceId ? { tts: { voice_id: voiceId } } : {}),
          },
        });
        tempAgentId = created.agent_id;
        return `created ${created.agent_id}`;
      },
    });

    if (tempAgentId) {
      await probe({
        name: "update agent",
        detail: "Create works but update does not. Fix updateAgent() — sync relies on it for every re-run.",
        run: async () => {
          await client.updateAgent(tempAgentId!, { name: "preflight-temp-agent-renamed" });
          return "patched";
        },
      });

      await probe({
        name: "delete agent (cleanup)",
        detail: `Could not delete. Remove agent ${tempAgentId} by hand in the dashboard.`,
        run: async () => {
          await client.deleteAgent(tempAgentId!);
          return "cleaned up";
        },
      });
    }

    let tempDocId: string | null = null;

    await probe({
      name: "create kb document",
      detail: "Fix createKnowledgeBaseText() — sync cannot push any knowledge base content without it.",
      run: async () => {
        const doc = await client.createKnowledgeBaseText(
          "preflight-temp-doc",
          "Temporary document created by a preflight check.",
        );
        tempDocId = doc.id;
        return `created ${doc.id}`;
      },
    });

    if (tempDocId) {
      await probe({
        name: "delete kb document (cleanup)",
        detail: `Could not delete. Remove document ${tempDocId} by hand in the dashboard.`,
        run: async () => {
          await client.deleteKnowledgeBaseDocument(tempDocId!);
          return "cleaned up";
        },
      });
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} probes passed.`,
  );

  if (failed.length > 0) {
    console.log("\nFix these in scripts/elevenlabs.ts before running sync:");
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.note}`);
    process.exit(1);
  }

  console.log(
    WRITE
      ? "\nAPI layer verified. Run `npm run sync:dry`, then `npm run sync`."
      : "\nRead paths verified. Run with --write to check the create payload before syncing.",
  );
}

main().catch((error) => {
  console.error(`\npreflight failed: ${error.message}`);
  process.exit(1);
});
