import { Hono } from "hono";
import type { Env } from "./env.js";
import { verifyToolSecret } from "./auth.js";
import { verifyPasscode } from "./routes/verify-passcode.js";
import { submitOpportunity } from "./routes/submit-opportunity.js";
import { postCall } from "./routes/post-call.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

// Agent tool calls authenticate with a shared secret. The post-call webhook is
// excluded — it carries an HMAC signature instead, verified in its handler.
app.use("/tools/*", async (c, next) => {
  if (!verifyToolSecret(c.req.raw, c.env.AGENT_TOOL_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.post("/tools/verify-passcode", verifyPasscode);
app.post("/tools/submit-opportunity", submitOpportunity);
app.post("/webhooks/post-call", postCall);

app.onError((error, c) => {
  console.error("unhandled error", error);
  return c.json({ error: "internal error" }, 500);
});

export default app;
