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

/** Reads a line with the terminal echo suppressed. */
function prompt(question: string, secret: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    if (secret && process.stdin.isTTY) {
      // readline still consumes the keystrokes; this just stops them rendering.
      const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: unknown };
      output._writeToOutput = function (chunk: string) {
        if (chunk.includes(question)) output.output.write(question);
      };
    }

    rl.question(question, (answer) => {
      if (secret) process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
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

  console.log("\nTwo values to set now. Leave either blank to fill in later.\n");

  const apiKey = await prompt("  ELEVENLABS_API_KEY (hidden): ", true);
  if (apiKey) contents = setValue(contents, "ELEVENLABS_API_KEY", apiKey);

  const voiceId = await prompt("  ELEVENLABS_VOICE_ID: ", false);
  if (voiceId) contents = setValue(contents, "ELEVENLABS_VOICE_ID", voiceId);

  await writeFile(ENV_PATH, contents);
  // writeFile's `mode` only applies when it creates the file, and copyFile
  // already made this one with the default umask. chmod is what actually
  // narrows it.
  await chmod(ENV_PATH, 0o600);

  console.log(`
Wrote .env (mode 600, git-ignored).

  ${apiKey ? "set" : "EMPTY"}  ELEVENLABS_API_KEY
  ${voiceId ? "set" : "EMPTY"}  ELEVENLABS_VOICE_ID

Everything else in .env belongs to the Worker and is set with
\`wrangler secret put\` instead — see docs/SETUP.md step 4.

Next:  npm run preflight
`);
}

main().catch((error) => {
  console.error(`\ninit:env failed: ${error.message}`);
  process.exit(1);
});
