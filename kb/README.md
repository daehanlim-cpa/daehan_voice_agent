# Knowledge base

Every factual claim the agents make about Daehan comes from here. If it isn't in
these files, the agents are instructed to say they don't know — so a gap shows up
as "I don't have that one", never as an invention.

## Layout

| Directory | Reaches | Contains |
|---|---|---|
| `recruiter/` | all three agents | public professional record |
| `friend/` | friend, virtual-me | personal context, current life |
| `virtual-me/` | virtual-me only | opinions, stories, humor, speech patterns |

Access is cumulative: `friend` sees `recruiter` + `friend`, `virtual-me` sees all
three. Put a fact in the narrowest directory that should reach it.

## Rules

**Nothing sensitive, in any file.** Home address, exact location, personal phone
and email, financial details, government IDs, family members' details, and
anything about a third party who hasn't agreed to it. The passcode gate raises
the bar for reaching `friend/` and `virtual-me/`, but it doesn't authenticate
anyone — a passphrase can be passed around. The prompts refuse to share these
things, but prompt-level defenses are the second line. Not writing it down is the
first.

**Never the passcode.** It lives as a server-side secret. A passcode in a
knowledge base is a passcode the agent can be talked into repeating.

**Never the screening bar.** Comp floor and criteria live in the Workers
environment. The recruiter agent gets a verdict, never the thresholds.

**Write facts, not marketing.** These files are read aloud by something that
can't tell confident phrasing from true phrasing. "Led the migration off
Postgres in 2023" is useful; "passionate about scalable systems" is noise that
will get paraphrased into a claim.

**Be exact about dates and numbers, or leave them out.** A hedge in the source
becomes a firm statement by the time it reaches a hiring manager. If you're not
sure whether it was 2021 or 2022, write "around 2021" — the agent will repeat
the hedge.

## Format

Plain markdown, short sections, one topic per heading. Files in a directory are
concatenated alphabetically into a single document at sync time, so filenames
control ordering. `README.md` is skipped.

Q&A phrasing works better than prose for anything callers actually ask —
retrieval and the model both do better when the question is present in the text.
