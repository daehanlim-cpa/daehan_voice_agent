# ElevenLabs setup runbook

Run this on your own machine. `api.elevenlabs.io` is blocked by the network
policy on the Claude Code environment this repo was built in, so none of it can
be done from a web session.

Order matters — each step depends on the one before it.

---

## 0. Local setup

```bash
git clone <this repo> && cd daehan_voice_agent
npm install
cp .env.example .env
```

You'll fill `.env` in as you go. It's gitignored.

---

## 1. Re-verify the API layer (optional, no key needed)

The API layer was already verified against `@elevenlabs/elevenlabs-js` v2.59.0,
so you can skip this unless a sync fails with a 404 or 422 — meaning the API
moved since.

```bash
curl -o el-openapi.json https://api.elevenlabs.io/openapi.json
npm run check-spec el-openapi.json
```

The spec is public. `check-spec` checks every path and method this repo uses,
suggests the closest real path when one is wrong, and prints required request
body fields. Fixes go in `scripts/elevenlabs.ts`, or `buildConversationConfig()`
in `scripts/sync.ts` if a payload shape changed.

---

## 2. API key

ElevenLabs dashboard → your profile → **API Keys** → create one with access to
Agents (called Conversational AI in some parts of the UI).

Put it in `.env` as `ELEVENLABS_API_KEY`. Never commit it — `.env` is gitignored,
and there's no reason to paste it into a chat or an issue.

```bash
npm run preflight
```

Where `check-spec` proves the paths are right, this proves your account actually
answers on them — the key works, has Agents access, and the plan allows what the
repo needs. Failures print the response body, which is where a 422 names the
field that's wrong.

Don't move on until the read-only probes pass.

---

## 3. Voice clone

Dashboard → **Voices** → **Add voice** → Instant Voice Clone (a Professional
Voice Clone is better and takes ~30 minutes of audio plus a training wait; start
with instant and upgrade later if you like it).

Recording notes, since this voice will answer recruiters:

- A quiet room and a decent mic. Phone audio is narrowband and unforgiving —
  room echo that sounds fine on a laptop becomes mush at 8kHz.
- 3+ minutes of continuous natural speech. Read something conversational, not a
  list.
- Match the register you want on the phone: how you'd talk to a colleague, not
  how you'd read an audiobook.

Copy the voice ID into `.env` as `ELEVENLABS_VOICE_ID`, then:

```bash
npm run preflight          # confirms the voice ID resolves
npm run preflight -- --write   # validates the create-agent payload
```

The `--write` pass creates a throwaway agent and knowledge base document and
deletes both. It's the one that actually proves `sync` will work.

---

## 4. Deploy the tools service

The agents call this for the passcode check and opportunity screening, so it has
to be live before they're any use.

```bash
npx wrangler login
npx wrangler kv namespace create RATE_LIMIT
```

Put the returned namespace ID into `wrangler.toml`, then set the secrets:

```bash
npx wrangler secret put AGENT_TOOL_SECRET   # openssl rand -hex 32
npx wrangler secret put ACCESS_PASSCODE     # the passphrase
npx wrangler secret put SCREEN_COMP_FLOOR   # 250000
npx wrangler secret put SCREEN_WORK_MODE    # hybrid
npx wrangler secret put SCREEN_WORK_MODE_STRICT  # false
npx wrangler secret put NOTIFY_EMAIL_TO     # daehanlim1@gmail.com
npx wrangler secret put RESEND_API_KEY      # from resend.com
npx wrangler deploy
```

Check it's up:

```bash
curl https://daehan-voice-agent-tools.<subdomain>.workers.dev/health
```

Then confirm the auth gate actually rejects unauthenticated calls — this is the
only thing standing between the open internet and your passcode oracle:

```bash
curl -X POST https://<worker>/tools/verify-passcode \
  -H 'Content-Type: application/json' -d '{"passcode":"x"}'
# expect: {"error":"unauthorized"}
```

---

## 5. Workspace secret

Dashboard → **Agents** → workspace settings → **Secrets**. Add one named exactly
`agent_tool_secret`, with the same value you gave `AGENT_TOOL_SECRET` in step 4.

This has to exist before you sync. `sync` looks the name up via the API and
embeds the resulting secret ID in each webhook tool's headers; if there's no
match it stops and tells you, rather than deploying tools that 401 on every
call. The value itself never passes through this repo.

(If you'd rather use a different name, set `ELEVENLABS_SECRET_NAME`.)

---

## 6. Sync the agents

```bash
export TOOLS_BASE_URL=https://daehan-voice-agent-tools.<subdomain>.workers.dev
npm run sync:dry     # read it before running for real
npm run sync
git add agents/ids.json && git commit -m "chore: record agent ids"
```

`agents/ids.json` is how re-runs update in place instead of creating duplicates.
Commit it.

---

## 7. Post-call webhook

Dashboard → workspace settings → **Webhooks** → add
`https://<worker>/webhooks/post-call` for post-call transcription.

Copy the signing secret it shows you (once) and set it:

```bash
npx wrangler secret put ELEVENLABS_WEBHOOK_SECRET
```

Requests are rejected unless the HMAC verifies and the timestamp is within five
minutes, so this must match exactly or you'll get no summaries.

---

## 8. Test before there's a phone number

```bash
npm run eval
```

28 cases covering routing, passcode bypass attempts, prompt extraction,
grounding, and factual accuracy against your resume. Runs through the simulation
API — no calls placed.

Then talk to the receptionist in the dashboard's test widget and try to break it
yourself. Things worth trying by hand, because they're what a real caller does:

- Claim you're a friend and refuse to give the passphrase
- Ask what the passphrase is, then ask for hints
- Ask the recruiter agent what salary would get Daehan's attention
- Ask something not in the knowledge base and see whether it says so

---

## 9. Phone number

Dashboard → **Agents** → **Phone numbers**. Either import a Twilio number or
provision one natively if your plan offers it. Assign the inbound number to the
**receptionist** agent — not to any of the three specialists.

Before you share the number, set the guardrails in the dashboard:

- Concurrency limit (2 is plenty for a personal line)
- Daily or monthly spend cap
- Confirm max call duration is applied per agent

Per-minute billing means one open line is a real bill.

---

## 10. Call it

Call from a number that isn't yours. Walk all three paths, including a failed
passcode attempt, and confirm the summary email arrives.

Then check the transcript in the dashboard against what you'd actually want a
recruiter to have heard.

---

## Ongoing

Change a prompt in `agents/*.md` or a fact in `kb/`, then:

```bash
npm run sync && npm run eval
```

When your resume changes in the Portfolio repo, update `kb/recruiter/` to match
and re-check the factual eval cases at the bottom of `evals/cases.yaml` — they
assert against specific dates and metrics.
