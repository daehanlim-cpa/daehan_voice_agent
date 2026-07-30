/**
 * Creates .env from .env.example and verifies git will ignore it.
 *
 *   npm run init:env
 *
 * The verification is the point. A .env that git is tracking is worse than no
 * .env at all, because the mistake is invisible until the key is already
 * pushed. This refuses to write one it can't confirm is ignored.
 *
 * Secrets are read with echo off, so they don't land in shell history or
 * scrollback.
 */
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const EXAMPLE_PATH = join(ROOT, ".env.example");

const FORCE = process.argv.includes("--force");

type Asker = {
  ask: (question: string, secret: boolean) => Promise<string>;
  close: () => void;
};

/**
 * One readline interface reused for every question.
 *
 * A fresh interface per question looks equivalent but isn't: the first one
 * buffers everything available on stdin, so a second interface reading from a
 * pipe gets EOF immediately, its callback never fires, and the promise hangs
 * forever. Node then exits quietly with an empty event loop — no error, and
 * whatever came after the prompts simply never ran.
 */
async function createAsker(): Promise<Asker> {
  // Non-interactive stdin (a pipe, a heredoc, CI) is drained up front.
  // readline's question() cannot be used reliably here: it keeps consuming
  // lines into its own buffer between calls, so a line that arrives before the
  // next question is registered is dropped, and EOF closes the interface while
  // later questions still expect answers. Both fail silently.
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);

    return {
      ask: async (question) => {
        process.stdout.write(question);
        const value = (lines.shift() ?? "").trim();
        process.stdout.write("\n");
        return value;
      },
      close: () => {},
    };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // readline still consumes keystrokes when echo is off; this only stops them
  // being rendered. Toggled per question rather than per interface.
  let hideInput = false;
  let currentQuestion = "";
  const internals = rl as unknown as {
    output: NodeJS.WriteStream;
    _writeToOutput: (chunk: string) => void;
  };
  const writeNormally = internals._writeToOutput.bind(rl);
  internals._writeToOutput = (chunk: string) => {
    if (!hideInput) return writeNormally(chunk);
    if (chunk.includes(currentQuestion)) internals.output.write(currentQuestion);
  };

  const ask = (question: string, secret: boolean) =>
    new Promise<string>((resolve) => {
      hideInput = secret;
      currentQuestion = question;

      // Fires when stdin ends before an answer arrives. Without this the
      // promise never settles and the rest of the script is skipped silently.
      const onClose = () => resolve("");
      rl.once("close", onClose);

      rl.question(question, (answer) => {
        rl.removeListener("close", onClose);
        if (hideInput) process.stdout.write("\n");
        hideInput = false;
        resolve(answer.trim());
      });
    });

  return { ask, close: () => rl.close() };
}

/**
 * Confirms git would ignore the path. Returns false if git says otherwise or
 * isn't available — an unverifiable answer is treated as a failure, not a pass.
 */
function isIgnoredByGit(relativePath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", relativePath], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isTrackedByGit(relativePath: string): boolean {
  try {
    const out = execFileSync("git", ["ls-files", "--error-unmatch", relativePath], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function setValue(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(contents) ? contents.replace(pattern, line) : `${contents}\n${line}\n`;
}

async function main() {
  // Check the safety property before writing anything, not after.
  if (isTrackedByGit(".env")) {
    console.error(
      "\n.env is TRACKED by git. Do not put a key in it.\n\n" +
        "  git rm --cached .env\n" +
        "  git commit -m 'stop tracking .env'\n\n" +
        "If a key was ever committed, rotate it in the ElevenLabs dashboard first —\n" +
        "deleting the file does not remove it from history.\n",
    );
    process.exit(1);
  }

  if (!isIgnoredByGit(".env")) {
    console.error(
      "\ngit would not ignore .env — refusing to create it.\n\n" +
        "Expected a `.env` line in .gitignore. Add one, then re-run.\n",
    );
    process.exit(1);
  }

  if (existsSync(ENV_PATH) && !FORCE) {
    console.log("\n.env already exists. Re-run with --force to overwrite it.\n");
    process.exit(0);
  }

  await copyFile(EXAMPLE_PATH, ENV_PATH);
  let contents = await readFile(ENV_PATH, "utf8");
  let apiKeySet = false;
  let voiceIdSet = false;

  console.log("\nTwo values to set now. Leave either blank to fill in later.\n");

  const asker = await createAsker();
  try {
    const apiKey = await asker.ask("  ELEVENLABS_API_KEY (hidden): ", true);
    if (apiKey) contents = setValue(contents, "ELEVENLABS_API_KEY", apiKey);

    const voiceId = await asker.ask("  ELEVENLABS_VOICE_ID: ", false);
    if (voiceId) contents = setValue(contents, "ELEVENLABS_VOICE_ID", voiceId);

    apiKeySet = Boolean(apiKey);
    voiceIdSet = Boolean(voiceId);
  } finally {
    asker.close();
  }

  await writeFile(ENV_PATH, contents);
  // writeFile's `mode` only applies when it creates the file, and copyFile
  // already made this one with the default umask. chmod is what actually
  // narrows it.
  await chmod(ENV_PATH, 0o600);

  console.log(`
Wrote .env (mode 600, git-ignored).

  ${apiKeySet ? "set  " : "EMPTY"}  ELEVENLABS_API_KEY
  ${voiceIdSet ? "set  " : "EMPTY"}  ELEVENLABS_VOICE_ID

Everything else in .env belongs to the Worker and is set with
\`wrangler secret put\` instead — see docs/SETUP.md step 4.

Next:  npm run preflight
`);
}

main().catch((error) => {
  console.error(`\ninit:env failed: ${error.message}`);
  process.exit(1);
});
