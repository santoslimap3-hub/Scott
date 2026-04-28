# DM Auto-Tag Eval — Handoff to a Fresh Claude

This document captures everything a new Claude instance needs to continue work on
the `autotag_dms.js` evaluation accuracy problem. It is self-contained — the new
Claude does not need to re-read the prior transcript.

---

## Project context

OutreachAI is an AI system that clones Scott Northwolf's communication style for
Skool DMs. Repository root: `C:\Users\santo\Documents\Scott\Scott`. The relevant
script for this work is **`tool_scripts/autotag_dms.js`**, a Node.js tool that
auto-labels ~4,000 of Scott's DMs (in `data/dm_classified.json`) using
`gpt-4o-mini` with 50 stratified few-shots from `data/scott_dm_corrections.json`
(183 hand-labeled corrections from Scott himself).

**Run commands** (from the repo root, on Windows):
- `run_autotag_eval.bat` — runs `node tool_scripts/autotag_dms.js --eval`. Computes accuracy/Jaccard against held-out corrections.
- `run_autotag_full.bat` — runs the full tagging pass on all messages.

**Output schema** (5 fields per message):
- `tone_tags`: array of 1–5 strings from `VALID_TONES`
- `intent`: one string from `VALID_INTENTS`
- `sales_stage`: one of `awareness | engagement | nurture | ask`
- `dm_stage`: one of `connect | gather-intel | frame-outcome | share-authority | offer-call | send-calendly | nurture-free`, or `null`
- `nonsales`: boolean

**Tag vocabularies are defined at the top of `autotag_dms.js`** — search for
`VALID_TONES`, `VALID_INTENTS`, `VALID_SALES_STAGES`, `VALID_DM_STAGES`.

---

## The architecture of `autotag_dms.js`

```
loadJson(corrections) ──┐
                        ├─→ matchCorrections() ──→ scott-validated rows + contactByCorrectionId
loadJson(classified) ───┘
                                                        │
                        ┌───────────────────────────────┘
                        ▼
                 computeContactRoles()  ← roles: in-program-or-personal | prospect-active | prospect-cold | unknown
                        │
                        ▼
                 selectFewShots()       ← role-stratified (round 2): 45/25/15/15 split with floor of 6 per role
                        │
                        ▼
                 buildSystemPrompt()    ← injects role guidance + CONTRAST EXAMPLES + few-shots
                        │
                        ▼
                 applyHardRules()       ← deterministic catch for calendly/voice/sticker/emoji-only/short-ack/call-pitch
                        │ (if no rule fires)
                        ▼
                 classify()             ← LLM call: gpt-4o-mini, temperature=0, JSON mode
                        │
                        ▼
                 validate(parsed, message)
                        │
                        ├─→ enforceTonePatterns()    ← adds questions/hype/self-aggrandization/teasing-future-value/chit-chat/direct/brotherhood; dampens motivational/bonding-rapport/supportive-helpful
                        └─→ enforceSalesStage()      ← overrides on hard textual signals
```

`runEval()` runs the same pipeline against held-out corrections and reports
per-field accuracy + tone Jaccard.

---

## Scott's actual label distribution (across 183 corrections)

This is THE empirical prior — fixes that drift away from this regress.

**sales_stage:**
- `nurture` 60.1%, `engagement` 24.6%, `ask` 13.1%, `awareness` 0.5%, empty 1.6%

**intent:**
- `engagement-nurture` 33.9%, `acknowledgement` 13.7%, `close-to-call` 9.3%, `value-delivery` 8.2%, `info-gathering` 7.7%, `authority-proofing` 7.7%, `community-building` 6.6%, `redirect` 6.0%, `funneling` 2.7%, rare ones <1.5%

**nonsales:** True 65.6%, False 34.4%

**Top combos (sales_stage, intent, nonsales):**
- `(nurture, engagement-nurture, True)` = 42 (23%)
- `(nurture, acknowledgement, True)` = 17 (9%)
- `(ask, close-to-call, False)` = 15 (8%)
- `(engagement, engagement-nurture, True)` = 13 (7%) ← this one matters: engagement does happen with nonsales=true
- `(nurture, value-delivery, True)` = 10 (5%) ← value-delivery does happen with nonsales=true

**Tone usage (across 183 corrections):**
- `direct` 39.3%, `casual` 30.6%, `authority` 30.1%, `questions` 26.8%, `motivational` 26.2%, `hype` 23.0%, `chit-chat` 23.0%, `brotherhood` 20.8%, `teasing-future-value` 20.8%, `self-aggrandization` 18.0%, `bonding-rapport` 16.9%, `curiosity` 13.7%, `supportive-helpful` 13.1%, `praise` 10.9%, `empathy` 9.8%, `mystery-teasing` 9.3%, `storytelling` 8.7%, `humor` 8.2%, `gratitude` 6.6%, `tough-love` 6.0%, `vulnerability` 3.3%

---

## Eval history

| Metric | Baseline (round 0) | Round 1 | Round 2 (predicted) | Round 2 target |
|---|---|---|---|---|
| sales_stage acc | 66.9% | **52.3% (regressed)** | TBD | ≥78% |
| intent acc | 36.8% | 43.1% (improved) | TBD | ≥60% |
| dm_stage acc | 75.9% | 76.9% (slight up) | TBD | ≥82% |
| nonsales acc | 75.9% | **72.3% (regressed)** | TBD | ≥85% |
| tone Jaccard | 0.29 | 0.33 (improved) | TBD | ≥0.45 |
| LLM "unknown" role | 56/132 | 29/116 (fixed) | TBD | — |
| Rule hits | 12/133 | 14/130 | TBD | — |

**Round 2 has been applied to the file but not yet evaluated.** The next action
is for the user to run `run_autotag_eval.bat` and share the output.

---

## Round 0 → Round 1 fixes (already applied)

These were applied in the first pass. Most worked; some overshot.

### Bug fix: `runEval` was missing arguments
The call was `runEval(openai, corrections, fewShotIds)` but the signature is
`runEval(openai, corrections, fewShotIds, contactRoles, contactByCorrectionId)`.
This meant `contactRoles` and `contactByCorrectionId` were always `undefined` in
eval mode, so role inference always fell back to a weak heuristic. Result: 56/132
"unknown" roles in round 0. Fixed → 29/116 in round 1. **This was the single
biggest improvement.**

### Filtered empty corrections
3 of 183 corrections have empty `intent`/`sales_stage`. They poisoned eval (impossible to ever match) and could degrade few-shots. Now filtered at both points.

### Added `call-pitch` hard rule
Catches "let's schedule a call", "let's hop on a call", "got time for a call?", "when are you free for a call?" → `ask + close-to-call + offer-call + nonsales=false`. Targets messages where Scott proposes a call without including a Calendly URL.

### Added `enforceTonePatterns()` post-processor
Deterministically adds chronically-missed tones based on text cues:
- `questions` if `?` present
- `hype` on ALL-CAPS / "fucking" / "huge" / "!!" / "let's go"
- `self-aggrandization` on "I'm building/running/launching" + "my community/brand/etc."
- `teasing-future-value` on forward references ("see you soon", day-of-week + verb, "looking forward", "going to be seeing")
- `chit-chat` on life cues (parking, eating, GM, voice notes)
- `direct` on blunt openers ("no bro", "I don't")
- `brotherhood` only if ≥2 markers (deliberately prevents over-use)

### Rewrote tone-tag prose with frequency priors
Added Scott's actual usage rates next to each definition. Loosened "hype" (previously over-restricted to ALL-CAPS only). Tightened "brotherhood" (only if it's the address form).

### Improved `computeRoleFromContext` for eval mode
Added two extra signals: 3+ msgs each side → `in-program-or-personal`; greetings + 2+ Scott msgs → `in-program-or-personal`.

---

## Round 1 → Round 2 fixes (just applied — needs eval verification)

The round 1 changes to `RULE 3` and the role guidance overshot — they made
`engagement` and `nonsales=false` over-predicted. Round 2 corrects this without
losing the round-1 wins.

### Pass 1: Prompt rebalancing

**RULE 3 rewritten** — `nurture` is the strong default (~60% prior). `engagement` requires AT LEAST ONE of:
- (a) Real qualifying / outcome question to recipient
- (b) Coordination across people / specific deliverables
- (c) ≥40 words of substantive content (NOT life-update gratitude / philosophy)
- (d) Visible 3+ msg back-and-forth on each side

Includes explicit "looks long but is still nurture" examples, e.g. "I'm looking
forward to it, brother. Infinite gratitude... we are going to be seeing each
other a lot..." → nurture (heartfelt banter, not engagement).

**RULE 1 reinforced** — in-program-or-personal → nonsales=true ~85% as a sticky
prior. Only override on explicit upsell to a NEW offer. Discussing money/ads/
funnels is friendship/student business-talk, NOT a sales motion.

**Anti-patterns rewritten** — explicit word-count rule for ack:
- ≤5 words → almost always acknowledgement
- 6–15 words, ack opener, no question, no plan → acknowledgement
- 16+ words OR contains question → engagement-nurture

Also: value-delivery / info-gathering / authority-proofing dampened to ~5% each
for in-program contacts. Pick them ONLY when the message UNMISTAKABLY does the
thing (qualifying-question to advance funnel, deliberate teaching to build
desire, authority-flex aimed at a prospect).

**ROLE_GUIDANCE rewritten** with explicit prior percentages per role.

### Pass 2: Code post-processors

**`enforceSalesStage(message, modelStage, ...)`** — runs after `validate()`,
overrides the model's sales_stage on hard textual signals:

- Calendly URL / "let's schedule a call" / "ready for our call" / "see you in N min" → `ask`
- Emoji-only / image-omitted / sticker-omitted → `nurture`
- ≤4-word ack pattern ("thanks bro", "got it", "fire") → `nurture`
- ≤12 words with no '?' and model picked engagement → `nurture` (most common round-1 error)
- model picked engagement, but message <25 words, ≤2 sentences, no qualifying-Q, no coordination → `nurture`

When forced to `ask`, also sets `dm_stage = send-calendly` (if null) and `nonsales=false`. When forced to `nurture`, sets `dm_stage = null`.

**Unit-tested against 10 round-1 mismatches → 10/10 pass.**

**Tone dampening** added to `enforceTonePatterns`:
- Drops `motivational` on short pure-acks (≤8 words, no '?', no push-forward verb)
- Drops `bonding-rapport` if no "we/us/our/brother" present
- Drops `supportive-helpful` on Scott-bragging messages without "you"

### Pass 3: Few-shot strategy

**Hard-coded `CONTRAST EXAMPLES` block** added before the dynamic few-shots — 3 contrast pairs covering the most-confused boundaries:

- (A) "Thanks bro!" vs "Great, man. I still don't understand how you want the payment..." (both ack despite length difference)
- (B) Long heartfelt "looking forward, infinite gratitude, going to see each other a lot" → nurture+ack vs "Cool! Family or business?" → engagement+info-gathering
- (C) "no, bro, the add spent it's marketing expenses..." (correcting friend → redirect+nurture+nonsales=true) vs "Let's schedule a call to start working towards FREEDOM" (explicit pitch → ask+close-to-call+nonsales=false)

**`selectFewShots` rewritten** to stratify role-first (45% in-program, 25% prospect-active, 15% cold, 15% unknown; floor of 6 per role), then output-combo within each bucket. Required reordering `main()` so `computeContactRoles` runs before `selectFewShots`.

---

## Known gotchas / sync issue

The bash mount on this dev environment shows a stale view of the file (1146 lines
vs the canonical 1453). Use the `Read` tool (file path
`C:\Users\santo\Documents\Scott\Scott\tool_scripts\autotag_dms.js`) to verify
edits — that view is canonical and matches what the user runs via the .bat.
Don't trust `node -c` via the bash sandbox; if the Read tool shows a properly
closed file ending with `main().catch(function(e) { ... });`, it parses fine on
the user's Windows machine.

---

## Key file paths

```
C:\Users\santo\Documents\Scott\Scott\
├── tool_scripts/
│   ├── autotag_dms.js                  ← THE SCRIPT (1453 lines as of round 2)
│   ├── autotag_dms_eval.json           ← latest eval report (sample_diffs has 30 cases)
│   └── autotag_dms_audit.json          ← audit log from full runs
├── data/
│   ├── dm_classified.json              ← 8638 messages, ~4000 are Scott's
│   ├── scott_dm_corrections.json       ← 183 hand-labeled gold examples
│   └── dm_classified_backup_pre_autotag.json
├── bot/
│   └── .env                            ← OPENAI_API_KEY lives here
├── MD_plans/
│   ├── autotag_eval_round_2_plan.md    ← the round 2 plan
│   └── autotag_eval_handoff.md         ← THIS FILE
├── run_autotag_eval.bat                ← what the user runs to validate
└── run_autotag_full.bat
```

---

## How to diagnose the next eval output

When the user shares the next eval output:

1. Look at `accuracy.sales_stage`, `accuracy.intent`, `accuracy.dm_stage`, `accuracy.nonsales`, `tone_jaccard`. Compare to the round 2 targets.
2. Read `tool_scripts/autotag_dms_eval.json` and parse `sample_diffs[]`.
3. Build confusion matrices for `(expected, predicted)` on each field. Use Python; the JSON file may have null bytes appended, strip with `data.split('\x00')[0]` then find balanced JSON.
4. Categorize the 30 sample diffs by error type:
   - "X → Y" pairs in confusion → systematic prompt/rule issue
   - Tones missing vs over-predicted → calibration of `enforceTonePatterns`
5. For each pattern, decide whether to fix in:
   - System prompt prose (`buildSystemPrompt`)
   - Hard rules (`applyHardRules`)
   - Tone post-processor (`enforceTonePatterns`)
   - Sales-stage post-processor (`enforceSalesStage`)
   - Few-shots (add a contrast example)

The strongest lever for systematic errors is `enforceTonePatterns` /
`enforceSalesStage` since they're deterministic. Use prompt prose only for cases
that need real understanding (genuine vs sarcastic, sales motive vs friendship
talk).

---

## Open questions / fallback levers

If round 2 still misses targets:

1. **Switch classify model from gpt-4o-mini → gpt-4o** for hard cases (5–10× cost; only worth it if accuracy plateau is from model capability, not prompt design).
2. **Increase few-shot count** from 50 → 100. Watch context length on gpt-4o-mini (128K).
3. **Chain-of-thought**: have the model output `reasoning` field first before the tags. Often boosts intent/sales_stage accuracy on ambiguous cases.
4. **Two-stage classification**: first call decides `nonsales` + `sales_stage`, second call (with first-stage output as input) decides `intent` + `dm_stage` + `tones`. Reduces interaction effects between fields.
5. **Add an `info-gathering` vs `engagement-nurture` boundary detector** — these two confuse a lot. Could be done with a regex looking for "qualifying-shape" questions (what/how/why/where + offer/business/sales/funnel/customers).

---

## What to do first when continuing

Ask the user for the latest eval output. If they have it, paste it and run the
diagnosis steps above. If they don't, ask them to run `run_autotag_eval.bat` and
share the console output.

If accuracy is at or near targets, declare done. If not, identify the dominant
remaining failure mode and pick the right lever (prompt vs post-processor vs
few-shots vs fallback).
