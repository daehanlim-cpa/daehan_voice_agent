import type { Context } from "hono";
import type { Env } from "../env.js";
import { type Opportunity, agentFacingResult, assess } from "../screening.js";

interface Body extends Opportunity {
  conversation_id?: string;
}

/** Assessments live here until the post-call webhook collects them. */
export const assessmentKey = (conversationId: string) => `opportunity:${conversationId}`;

export async function submitOpportunity(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const body = await c.req.json<Body>().catch(() => ({}) as Body);

  const { conversation_id: conversationId, ...opportunity } = body;
  const assessment = assess(opportunity, env);

  // Stash it for the post-call webhook, which combines this structured capture
  // with the transcript into a single notification. Sending from here as well
  // would mean two messages per call.
  if (conversationId) {
    await env.RATE_LIMIT.put(
      assessmentKey(conversationId),
      JSON.stringify({ opportunity, assessment }),
      { expirationTtl: 60 * 60 * 24 },
    );
  } else {
    console.warn("submit_opportunity called without conversation_id; assessment not persisted");
  }

  // Only the verdict and neutral guidance go back. The blockers and concerns
  // describe Daehan's criteria, and anything the agent knows, a caller can ask
  // it for.
  return c.json(agentFacingResult(assessment));
}
