import type { Context } from "hono";
import type { Env } from "../env.js";
import { verifyWebhookSignature } from "../auth.js";
import type { Assessment, Opportunity } from "../screening.js";
import { notify } from "../notify.js";
import { assessmentKey } from "./submit-opportunity.js";

interface TranscriptTurn {
  role?: string;
  message?: string | null;
}

interface PostCallPayload {
  type?: string;
  data?: {
    agent_id?: string;
    conversation_id?: string;
    status?: string;
    transcript?: TranscriptTurn[];
    metadata?: {
      call_duration_secs?: number;
      start_time_unix_secs?: number;
      phone_call?: { external_number?: string };
    };
    analysis?: { transcript_summary?: string };
  };
}

interface StoredAssessment {
  opportunity: Opportunity;
  assessment: Assessment;
}

const VERDICT_LABEL: Record<string, string> = {
  strong: "STRONG — worth your time",
  possible: "POSSIBLE — your call",
  weak: "WEAK — did not clear the bar",
};

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return "unknown";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatOpportunity(stored: StoredAssessment): string {
  const { opportunity, assessment } = stored;
  const lines = [
    `VERDICT: ${VERDICT_LABEL[assessment.verdict] ?? assessment.verdict}`,
    "",
    `Caller:   ${opportunity.caller_name ?? "—"}`,
    `Company:  ${opportunity.company ?? "—"}`,
    `Role:     ${opportunity.role ?? "—"}`,
    `Comp:     ${opportunity.compensation ?? "—"}`,
    `Location: ${opportunity.location ?? "—"} (${opportunity.work_mode ?? "—"})`,
    `Stage:    ${opportunity.company_stage ?? "—"}`,
    `Contact:  ${opportunity.contact ?? "—"}`,
  ];

  if (opportunity.notes) lines.push("", `Notes: ${opportunity.notes}`);
  if (assessment.blockers.length) lines.push("", `Blockers: ${assessment.blockers.join("; ")}`);
  if (assessment.concerns.length) lines.push(`Concerns: ${assessment.concerns.join("; ")}`);
  if (assessment.positives.length) lines.push(`Positives: ${assessment.positives.join("; ")}`);
  if (assessment.missing.length) lines.push(`Not discussed: ${assessment.missing.join(", ")}`);

  return lines.join("\n");
}

function formatTranscript(turns: TranscriptTurn[] | undefined): string {
  if (!turns?.length) return "(no transcript)";
  return turns
    .filter((turn) => turn.message)
    .map((turn) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.message}`)
    .join("\n");
}

export async function postCall(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // Read the body as text: the signature covers the exact bytes sent, so
  // re-serializing parsed JSON would not reproduce the signed payload.
  const rawBody = await c.req.text();
  const valid = await verifyWebhookSignature(
    c.req.header("ElevenLabs-Signature") ?? null,
    rawBody,
    env.ELEVENLABS_WEBHOOK_SECRET,
  );

  if (!valid) {
    console.warn("post-call webhook rejected: bad signature");
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: PostCallPayload;
  try {
    payload = JSON.parse(rawBody) as PostCallPayload;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const data = payload.data;
  if (!data?.conversation_id) {
    return c.json({ error: "missing conversation_id" }, 400);
  }

  const storedRaw = await env.RATE_LIMIT.get(assessmentKey(data.conversation_id));
  const stored: StoredAssessment | null = storedRaw ? JSON.parse(storedRaw) : null;

  const caller = data.metadata?.phone_call?.external_number ?? "unknown";
  const duration = formatDuration(data.metadata?.call_duration_secs);

  const subject = stored
    ? `Opportunity (${stored.assessment.verdict}) — ${stored.opportunity.company ?? "unknown company"}`
    : `Call — ${caller}`;

  const sections = [
    `Caller: ${caller}`,
    `Duration: ${duration}`,
    `Conversation: ${data.conversation_id}`,
    "",
  ];

  if (stored) {
    sections.push(formatOpportunity(stored), "");
  }

  if (data.analysis?.transcript_summary) {
    sections.push("SUMMARY", data.analysis.transcript_summary, "");
  }

  sections.push("TRANSCRIPT", formatTranscript(data.transcript));

  // Deliver in the background so ElevenLabs gets a prompt 200. A slow or failing
  // notification provider would otherwise look like a webhook failure and get
  // retried, duplicating messages.
  c.executionCtx.waitUntil(notify(env, { subject, body: sections.join("\n") }));

  return c.json({ ok: true });
}
