# daehan_voice_agent

A phone line you can call to ask about Daehan. The caller says why they're
calling and gets routed to one of three agents — professional, friend, or
Daehan's virtual self — each with its own prompt, knowledge base, and rules.

Built on [ElevenLabs Agents](https://elevenlabs.io/docs/agents-platform).
This repo is the source of truth; ElevenLabs is a deploy target.

## How a call goes

```
inbound call
  └─ receptionist ── "why are you calling?"
       ├─ professional ─────────────────────→ recruiter agent
       ├─ friend ──────── passcode ─────────→ friend agent
       └─ fun / virtual self ── passcode ───→ virtual-me agent
```

The receptionist discloses that it's an AI and that the call may be recorded,
then routes. The professional path is open; the other two need a passphrase.

## Layout

```
agents/          one markdown file per agent: frontmatter + system prompt
  ids.json       agent + knowledge base IDs (committed, written by sync)
kb/              knowledge base, one directory per collection
tools/src/       Cloudflare Workers service backing the agent tools
scripts/sync.ts  pushes prompts + kb to ElevenLabs
scripts/eval.ts  runs evals/cases.yaml against live agents
evals/cases.yaml behavioral test cases
```

## Two things never live in this repo

**The passcode.** It's a server-side secret. The receptionist calls a
`verify_passcode` webhook and gets back `{valid, attempts_remaining, locked}` —
nothing more. It has no way to check the passphrase itself, so there's nothing
to extract from it. A passcode in a system prompt can be talked out of the model
by a caller who asks the right way; this design has no such failure mode.

**The screening bar.** Comp floor, work mode, stages, disqualifiers all live in
the Workers environment. `submit_opportunity` returns a verdict (`strong` /
`possible` / `weak`) and neutral guidance — never the reasons. Anything the
agent knows, a caller can ask it for.

Both are guarded in the prompts too, but prompts are the second line. Not
putting the value where the model can see it is the first.

## Setup

```bash
npm install
cp .env.example .env          # scripts
cp .env.example .dev.vars     # workers dev
```

### 1. Deploy the tools service

```bash
wrangler kv namespace create RATE_LIMIT   # put the id in wrangler.toml
wrangler secret put AGENT_TOOL_SECRET     # openssl rand -hex 32
wrangler secret put ACCESS_PASSCODE
wrangler secret put SCREEN_COMP_FLOOR     # ...and the other SCREEN_* vars
wrangler secret put NOTIFY_EMAIL_TO
wrangler secret put RESEND_API_KEY        # or SLACK_WEBHOOK_URL
npm run deploy
```

In the ElevenLabs dashboard, add a workspace secret named
`agent_tool_secret` matching `AGENT_TOOL_SECRET` — the tool definitions
reference it as `{{secret__agent_tool_secret}}` so the value never enters a
prompt.

### 2. Sync the agents

```bash
export TOOLS_BASE_URL=https://daehan-voice-agent-tools.<subdomain>.workers.dev
npm run sync:dry    # inspect first
npm run sync
git add agents/ids.json && git commit -m "chore: record agent ids"
```

Sync is idempotent — it updates in place using `agents/ids.json` and skips
knowledge base collections whose content hash hasn't changed.

### 3. Post-call webhook

Register `https://<worker>/webhooks/post-call` in the ElevenLabs dashboard and
put the signing secret in `ELEVENLABS_WEBHOOK_SECRET`. Requests are rejected
unless the HMAC verifies and the timestamp is within five minutes.

### 4. Evals

```bash
npm run eval
```

Runs against live agents through the simulation API — no calls placed. Gate
deploys on this.

## Editing

Change a prompt in `agents/*.md`, add a fact to `kb/`, then `npm run sync`.
Everything the agents say traces back to a file in this repo, and every change
shows up in a diff.

Adding an agent means a new `agents/<slug>.md` plus a `transfers` entry on the
receptionist. Adding a knowledge collection means a new `kb/<name>/` directory
plus a `knowledge_base` entry on whichever agents should see it.

## Known unverified

`scripts/elevenlabs.ts` was written against the documented Agents API but never
run against a live key — `api.elevenlabs.io` was unreachable from the
environment this was built in. Endpoint paths and payload shapes may need
correcting on the first real sync. They are deliberately confined to that one
file. Start with `npm run sync:dry`, then a real sync, and fix what 4xxs.

The `llm` values in the agent frontmatter (`claude-sonnet-4-5`) should be
checked against the model list your ElevenLabs account actually exposes.

## Knowledge base status

`kb/recruiter/` is written, sourced from `content/resume.md` and
`data/projects.ts` in the [Portfolio](https://github.com/daehanlim-cpa/Portfolio)
repo. When the resume changes there, update here and re-sync — and check the
factual cases at the bottom of `evals/cases.yaml`, which assert against it.

`kb/friend/` and `kb/virtual-me/` have their public-derived sections filled in
from his blog posts; the personal material is still commented-out prompts.
The agents will honestly say they don't know until those are written.

## Guardrails

Per-agent max call duration is set in frontmatter. Passcode attempts are rate
limited per caller number (5/hour by default) so a low-entropy phrase can't be
brute forced. Set a concurrency cap and a spend alert in the ElevenLabs
dashboard — per-minute billing means one open line is a real bill.

## Legal

The greeting discloses AI and possible recording. Several jurisdictions —
California among them — require one or both. Don't remove it from
`agents/receptionist.md`.
