# Handoff brief

Paste the block below to Claude running **on Daehan's own machine** (Cowork, the
Claude Code CLI, or an IDE extension) with this repo open.

It cannot be done from a Claude Code web session: that environment's network
policy blocks `api.elevenlabs.io` and `api.cloudflare.com`, which is every host
this work needs.

---

## The brief

> You're setting up a voice agent that lives in this repo. Read `docs/SETUP.md`
> first — it's the authoritative runbook and this brief is a summary of it.
>
> Work through steps 2 to 8. Stop and ask me whenever you need a value; don't
> invent one, and don't guess at a placeholder.
>
> **Ground rules**
>
> - Never write a secret into a file that git tracks. `.env` and `.dev.vars` are
>   gitignored; keep it that way. Don't paste secret values into commit
>   messages, and don't echo them into the terminal.
> - `agents/ids.json` **is** meant to be committed — it holds resource IDs, not
>   secrets, and without it every sync creates duplicate agents.
> - Don't `git push` unless I ask. Committing locally is fine.
>
> **Step 2 — API key.** Run `npm install`, then `npm run init:env`. It'll prompt
> for my ElevenLabs API key and voice ID and refuse to run if `.env` isn't
> git-ignored. Then `npm run preflight` and show me the output. Don't continue
> if the read-only probes fail.
>
> **Step 3 — voice.** I'm using a stock ElevenLabs voice, not a clone. If I
> haven't given you a voice ID yet, ask for it. Then
> `npm run preflight -- --write`, which creates and deletes a throwaway agent to
> confirm the create payload is right. Show me the output.
>
> **Step 4 — deploy the Worker.** In order:
> 1. `npx wrangler login` — tell me when the browser opens so I can approve.
> 2. `npx wrangler kv namespace create RATE_LIMIT`, then put the returned ID into
>    `wrangler.toml` replacing `REPLACE_WITH_KV_NAMESPACE_ID`.
> 3. Set these with `npx wrangler secret put <NAME>`, asking me for each value:
>    `AGENT_TOOL_SECRET` (generate with `openssl rand -hex 32` and show me — I
>    need it again in step 5), `ACCESS_PASSCODE`, `SCREEN_COMP_FLOOR`,
>    `SCREEN_WORK_MODE`, `SCREEN_WORK_MODE_STRICT`, `NOTIFY_EMAIL_TO`,
>    `RESEND_API_KEY`.
> 4. `npm run deploy`.
> 5. Verify: `curl https://<worker-url>/health` returns ok, and
>    `curl -X POST https://<worker-url>/tools/verify-passcode -H 'Content-Type:
>    application/json' -d '{"passcode":"x"}'` returns
>    `{"error":"unauthorized"}`. That second one matters — it's the only thing
>    between the open internet and a passcode-guessing oracle. If it returns
>    anything else, stop and tell me.
>
> **Step 5 — workspace secret.** Tell me to go to the ElevenLabs dashboard →
> Agents → workspace settings → Secrets, and create one named exactly
> `agent_tool_secret` with the same value as `AGENT_TOOL_SECRET` from step 4.
> Wait for me to confirm before continuing — `sync` looks this up by name and
> will stop if it's missing.
>
> **Step 6 — sync.** Export `TOOLS_BASE_URL` to the deployed Worker URL. Run
> `npm run sync:dry` and show me the output. Wait for my go-ahead, then
> `npm run sync`, then commit `agents/ids.json`.
>
> **Step 7 — post-call webhook.** Tell me to register
> `https://<worker-url>/webhooks/post-call` in the ElevenLabs dashboard under
> workspace settings → Webhooks, for post-call transcription. It shows a signing
> secret once — I'll give it to you, then set it with
> `npx wrangler secret put ELEVENLABS_WEBHOOK_SECRET` and redeploy.
>
> **Step 8 — evals.** `npm run eval`. 28 cases covering routing, passcode bypass
> attempts, prompt extraction, grounding, and factual accuracy against my
> resume. Show me every failure with its case ID. Don't "fix" a failure by
> loosening the eval — if a case fails, the prompt or the knowledge base is what
> should change, and check with me first.
>
> **If something 4xxs.** All ElevenLabs calls are in `scripts/elevenlabs.ts`;
> payload construction is in `buildConversationConfig()` and `toolDefinitions()`
> in `scripts/sync.ts`. Paths were verified against
> `@elevenlabs/elevenlabs-js` v2.59.0 but never run live, so a mismatch is
> possible. `npm run check-spec el-openapi.json` (after
> `curl -o el-openapi.json https://api.elevenlabs.io/openapi.json`) re-checks
> everything offline. Show me the error body — on a 422 it names the field.
>
> Stop after step 8 and report. Don't provision a phone number; I want to hear it
> in the dashboard test widget first.

---

## Values to have ready

| Value | Where it comes from |
|---|---|
| ElevenLabs API key | dashboard → profile → API Keys |
| Voice ID | dashboard → Voices → Library |
| `ACCESS_PASSCODE` | the passphrase you've chosen |
| `SCREEN_COMP_FLOOR` | `250000` |
| `SCREEN_WORK_MODE` | `hybrid` |
| `SCREEN_WORK_MODE_STRICT` | `false` |
| `NOTIFY_EMAIL_TO` | `daehanlim1@gmail.com` |
| `RESEND_API_KEY` | resend.com, free tier is fine |

`AGENT_TOOL_SECRET` is generated during the run, not beforehand — but write it
down when it appears, because step 5 needs the same value in the ElevenLabs
dashboard.

## What's deliberately left out

**Phone number.** Provision it only after listening to all three paths in the
dashboard test widget. Once a number is live, anyone who has it can run up
per-minute charges, so set a concurrency cap and a spend limit at the same time.

**`kb/friend/` and `kb/virtual-me/`.** Their public-derived sections are written;
the personal material is still commented-out prompts. Those agents will honestly
say they don't know until it's filled in — which is correct behaviour, not a bug.
That's an interview, not a setup task.
