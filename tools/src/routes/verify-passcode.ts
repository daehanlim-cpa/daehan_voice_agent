import type { Context } from "hono";
import type { Env } from "../env.js";
import { intVar } from "../env.js";
import { timingSafeEqual } from "../auth.js";
import { bumpCounter, callerKey, clearCounter, readCounter } from "../ratelimit.js";

interface Body {
  passcode?: string;
  caller_id?: string;
}

/**
 * Speech-to-text will not hand back a clean string. "Green Apple" arrives as
 * "green apple", "Green apple.", "green-apple", sometimes "greenapple".
 * Comparing on letters and digits alone absorbs all of that without weakening
 * the check in any way that matters for a two-word phrase.
 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function verifyPasscode(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const body = await c.req.json<Body>().catch(() => ({}) as Body);

  const maxAttempts = intVar(env.MAX_PASSCODE_ATTEMPTS, 5);
  const windowSeconds = intVar(env.PASSCODE_WINDOW_SECONDS, 3600);
  const key = callerKey("passcode", body.caller_id);

  // Check the existing count before spending an attempt, so a locked-out caller
  // doesn't extend their own window on every retry.
  if ((await readCounter(env, key)) >= maxAttempts) {
    return c.json({ valid: false, attempts_remaining: 0, locked: true });
  }

  const supplied = normalize(body.passcode ?? "");
  const expected = normalize(env.ACCESS_PASSCODE ?? "");

  // An unset passcode must fail closed. Without this, a missing secret would
  // make every empty guess match and open the gated paths to everyone.
  if (!expected) {
    console.error("ACCESS_PASSCODE is not set — refusing all passcode checks");
    return c.json({ valid: false, attempts_remaining: 0, locked: true });
  }

  if (supplied && timingSafeEqual(supplied, expected)) {
    await clearCounter(env, key);
    return c.json({ valid: true, attempts_remaining: maxAttempts, locked: false });
  }

  const state = await bumpCounter(env, key, maxAttempts, windowSeconds);
  return c.json({
    valid: false,
    attempts_remaining: state.remaining,
    locked: state.remaining <= 0,
  });
}
