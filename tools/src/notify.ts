import type { Env } from "./env.js";

export interface Notification {
  subject: string;
  body: string;
}

async function sendEmail(env: Env, notification: Notification): Promise<void> {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL_TO) {
    throw new Error("email notifications configured but RESEND_API_KEY/NOTIFY_EMAIL_TO missing");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Voice Agent <onboarding@resend.dev>",
      to: [env.NOTIFY_EMAIL_TO],
      subject: notification.subject,
      text: notification.body,
    }),
  });

  if (!response.ok) {
    throw new Error(`resend ${response.status}: ${await response.text()}`);
  }
}

async function sendSlack(env: Env, notification: Notification): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    throw new Error("slack notifications configured but SLACK_WEBHOOK_URL missing");
  }

  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `*${notification.subject}*\n\`\`\`${notification.body}\`\`\``,
    }),
  });

  if (!response.ok) {
    throw new Error(`slack ${response.status}: ${await response.text()}`);
  }
}

/**
 * Delivers to whichever channels are configured.
 *
 * Never throws: a failed notification must not fail the webhook back to
 * ElevenLabs, or a delivery outage turns into retried or dropped calls. Errors
 * are logged and surfaced in the return value instead.
 */
export async function notify(
  env: Env,
  notification: Notification,
): Promise<{ delivered: string[]; failed: string[] }> {
  const channel = (env.NOTIFY_CHANNEL ?? "email").toLowerCase();
  const targets: string[] = [];
  if (channel === "email" || channel === "both") targets.push("email");
  if (channel === "slack" || channel === "both") targets.push("slack");

  const delivered: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    targets.map(async (target) => {
      try {
        if (target === "email") await sendEmail(env, notification);
        else await sendSlack(env, notification);
        delivered.push(target);
      } catch (error) {
        failed.push(target);
        console.error(`notify:${target} failed`, error);
      }
    }),
  );

  return { delivered, failed };
}
