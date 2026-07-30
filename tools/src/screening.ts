import { type Env, intVar, listVar } from "./env.js";

export interface Opportunity {
  caller_name?: string;
  company?: string;
  role?: string;
  compensation?: string;
  location?: string;
  work_mode?: string;
  company_stage?: string;
  contact?: string;
  notes?: string;
}

export type Verdict = "strong" | "possible" | "weak";

export interface Assessment {
  verdict: Verdict;
  /** Reasons, for Daehan's summary only. Never returned to the agent. */
  blockers: string[];
  concerns: string[];
  positives: string[];
  missing: string[];
}

const CRITICAL_FIELDS: (keyof Opportunity)[] = ["company", "role", "compensation"];

/**
 * Pulls a salary range out of whatever a recruiter said out loud.
 *
 * Handles "$150k", "150-180k", "150 to 180", "around 200000". Returns
 * annualised dollars. Bare numbers under 1000 are read as thousands, since
 * "one fifty to one eighty" is how this is actually said on a phone call.
 */
export function parseCompensation(
  raw: string | undefined,
): { low: number; high: number } | null {
  if (!raw) return null;

  const text = raw.toLowerCase().replace(/,/g, "");
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(k|m)?/g)];
  if (matches.length === 0) return null;

  const values: number[] = [];
  for (const match of matches) {
    let value = Number.parseFloat(match[1] ?? "");
    if (!Number.isFinite(value)) continue;

    const suffix = match[2];
    if (suffix === "k") value *= 1_000;
    else if (suffix === "m") value *= 1_000_000;
    else if (value < 1_000) value *= 1_000;

    // Drop anything that clearly isn't a salary — equity percentages, years.
    if (value >= 10_000) values.push(value);
  }
  if (values.length === 0) return null;

  return { low: Math.min(...values), high: Math.max(...values) };
}

function mentions(haystack: string | undefined, needles: string[]): string | null {
  if (!haystack || needles.length === 0) return null;
  const text = haystack.toLowerCase();
  return needles.find((needle) => text.includes(needle)) ?? null;
}

export function assess(opportunity: Opportunity, env: Env): Assessment {
  const blockers: string[] = [];
  const concerns: string[] = [];
  const positives: string[] = [];
  const missing: string[] = [];

  for (const field of CRITICAL_FIELDS) {
    if (!opportunity[field]?.trim()) missing.push(field);
  }

  const haystack = [
    opportunity.role,
    opportunity.company,
    opportunity.notes,
    opportunity.compensation,
  ]
    .filter(Boolean)
    .join(" ");

  // Disqualifiers first — these override everything else.
  const disqualifier = mentions(haystack, listVar(env.SCREEN_DISQUALIFIERS));
  if (disqualifier) blockers.push(`disqualifier: ${disqualifier}`);

  const excludedRole = mentions(opportunity.role, listVar(env.SCREEN_ROLES_NO));
  if (excludedRole) blockers.push(`excluded role: ${excludedRole}`);

  const wantedRole = mentions(opportunity.role, listVar(env.SCREEN_ROLES_YES));
  if (wantedRole) positives.push(`target role: ${wantedRole}`);

  // Compensation. An unparseable answer is a concern, not a blocker — plenty of
  // real opportunities open with "depends on experience".
  const floor = intVar(env.SCREEN_COMP_FLOOR, 0);
  if (floor > 0) {
    const comp = parseCompensation(opportunity.compensation);
    if (!comp) {
      concerns.push("no compensation figure given");
    } else if (comp.high < floor) {
      blockers.push(`comp below floor (top of range ${comp.high})`);
    } else if (comp.low < floor) {
      concerns.push(`comp straddles floor (${comp.low}–${comp.high})`);
    } else {
      positives.push(`comp clears floor (${comp.low}–${comp.high})`);
    }
  }

  // Work mode. A preference and a requirement are different things: unless
  // SCREEN_WORK_MODE_STRICT is set, a mismatch lowers the verdict to "possible"
  // rather than killing it, so a flexible preference doesn't silently reject
  // roles that are otherwise a fit.
  const wantedMode = (env.SCREEN_WORK_MODE ?? "any").trim().toLowerCase();
  if (wantedMode && wantedMode !== "any") {
    const strict = (env.SCREEN_WORK_MODE_STRICT ?? "false").toLowerCase() === "true";
    const stated = (opportunity.work_mode ?? "").toLowerCase();

    if (!stated) {
      concerns.push("work mode not stated");
    } else if (stated.includes(wantedMode)) {
      positives.push(`work mode matches (${wantedMode})`);
    } else if (strict) {
      blockers.push(`work mode mismatch: wanted ${wantedMode}, got ${stated}`);
    } else {
      concerns.push(`${stated} against a ${wantedMode} preference`);
    }
  }

  const locations = listVar(env.SCREEN_LOCATIONS);
  if (locations.length > 0 && opportunity.location) {
    if (mentions(opportunity.location, locations)) {
      positives.push(`location matches (${opportunity.location})`);
    } else {
      concerns.push(`location outside preferred set (${opportunity.location})`);
    }
  }

  const stages = listVar(env.SCREEN_STAGES);
  if (stages.length > 0 && opportunity.company_stage) {
    if (mentions(opportunity.company_stage, stages)) {
      positives.push(`stage matches (${opportunity.company_stage})`);
    } else {
      concerns.push(`stage outside preferred set (${opportunity.company_stage})`);
    }
  }

  let verdict: Verdict;
  if (blockers.length > 0) {
    verdict = "weak";
  } else if (concerns.length > 0 || missing.length > 0 || positives.length === 0) {
    verdict = "possible";
  } else {
    verdict = "strong";
  }

  return { verdict, blockers, concerns, positives, missing };
}

/**
 * What the agent is allowed to see.
 *
 * Only the verdict and a neutral instruction cross this boundary — the reasons
 * stay server-side. Anything returned here can be extracted from the agent by a
 * caller who asks the right questions, so it must not describe the criteria.
 */
export function agentFacingResult(assessment: Assessment): {
  verdict: Verdict;
  guidance: string;
} {
  const guidance: Record<Verdict, string> = {
    strong:
      "Daehan is likely to be interested. Confirm the best way to reach them and say he'll follow up directly.",
    possible:
      "Worth passing along. Say you'll flag it for him, without promising a reply.",
    weak: "Probably not a fit right now. Be warm and brief, say you'll pass it along, and do not explain why or invite a revised offer.",
  };
  return { verdict: assessment.verdict, guidance: guidance[assessment.verdict] };
}
