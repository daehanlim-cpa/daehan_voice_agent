export interface Env {
  RATE_LIMIT: KVNamespace;

  // Auth
  AGENT_TOOL_SECRET: string;
  ELEVENLABS_WEBHOOK_SECRET: string;

  // Access gate
  ACCESS_PASSCODE: string;

  // Screening bar
  SCREEN_COMP_FLOOR?: string;
  SCREEN_WORK_MODE?: string;
  SCREEN_LOCATIONS?: string;
  SCREEN_STAGES?: string;
  SCREEN_ROLES_YES?: string;
  SCREEN_ROLES_NO?: string;
  SCREEN_DISQUALIFIERS?: string;

  // Notifications
  NOTIFY_CHANNEL?: string;
  NOTIFY_EMAIL_TO?: string;
  RESEND_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;

  // Guardrails
  MAX_PASSCODE_ATTEMPTS?: string;
  PASSCODE_WINDOW_SECONDS?: string;
  MAX_CALLS_PER_NUMBER_PER_DAY?: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function listVar(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}
