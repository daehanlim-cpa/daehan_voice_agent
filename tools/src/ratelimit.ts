import type { Env } from "./env.js";

export interface CounterState {
  count: number;
  remaining: number;
  limited: boolean;
}

/**
 * Fixed-window counter in KV.
 *
 * Fixed windows allow up to 2x the limit across a window boundary, which is
 * fine for the scale here — this guards a personal phone line, not an API. KV
 * is also eventually consistent, so a burst of truly concurrent calls can slip
 * past by a small margin. Both are acceptable given the backstops (ElevenLabs
 * concurrency caps, max call duration).
 */
export async function bumpCounter(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<CounterState> {
  const stored = await env.RATE_LIMIT.get(key);
  const count = (stored ? Number.parseInt(stored, 10) || 0 : 0) + 1;

  // Refresh the TTL on every write: the window starts at the first attempt and
  // extends while activity continues, so a slow drip can't outlast it.
  await env.RATE_LIMIT.put(key, String(count), {
    expirationTtl: Math.max(windowSeconds, 60),
  });

  return {
    count,
    remaining: Math.max(0, limit - count),
    limited: count > limit,
  };
}

export async function readCounter(env: Env, key: string): Promise<number> {
  const stored = await env.RATE_LIMIT.get(key);
  return stored ? Number.parseInt(stored, 10) || 0 : 0;
}

export async function clearCounter(env: Env, key: string): Promise<void> {
  await env.RATE_LIMIT.delete(key);
}

/** Callers without caller ID share one bucket rather than bypassing limits. */
export function callerKey(prefix: string, callerId: string | undefined): string {
  const id = (callerId ?? "").trim() || "unknown";
  return `${prefix}:${id}`;
}

export function dayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
