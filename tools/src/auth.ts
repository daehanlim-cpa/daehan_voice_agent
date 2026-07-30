/**
 * Constant-time comparison. Compares over a fixed number of iterations so the
 * time taken doesn't reveal how many leading characters matched.
 *
 * Length still leaks (unavoidable without hashing first), which is why callers
 * that guard a low-entropy secret — the passcode — also rate limit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** Authenticates a tool call from an ElevenLabs agent via shared secret. */
export function verifyToolSecret(request: Request, expected: string): boolean {
  const provided = request.headers.get("X-Agent-Secret");
  if (!provided || !expected) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Verifies an ElevenLabs post-call webhook signature.
 *
 * The `ElevenLabs-Signature` header carries `t=<unix seconds>,v0=<hex hmac>`,
 * where the HMAC is SHA-256 over `${timestamp}.${rawBody}`.
 *
 * The timestamp check is what stops replay: a captured request stays valid
 * forever without it.
 */
export async function verifyWebhookSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;

  let timestamp = "";
  let signature = "";
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") timestamp = value ?? "";
    if (key === "v0") signature = value ?? "";
  }
  if (!timestamp || !signature) return false;

  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - sentAt);
  if (age > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, signature);
}
