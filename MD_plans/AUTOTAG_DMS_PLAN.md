# DM Auto-Tagging Plan — Using Scott's 183 Corrections

## Goal

Re-label all 4,016 of Scott's messages in `data/dm_classified.json` in the most authentic-to-Scott way possible, using the 183 manual corrections in `data/scott_dm_corrections.json` as ground truth and few-shot guidance.

## Data summary

- `data/dm_classified.json` — 8,638 total messages across 370 contacts; 4,016 are Scott's. 1,992 already have AI-suggested tags (with known errors), 2,024 are completely untagged.
- `data/scott_dm_corrections.json` — 183 manual corrections by Scott. All of them changed at least one tag. Only ~65–84 of them match rows in `dm_classified.json` because the corrections were taken from a newer dataset (Apr 2026) than the classified file (last updated Dec 2025).

## Patterns extracted from Scott's 183 corrections

1. **`sales_stage` was the most-corrected field** (140 of 183 corrections, 76%). The previous LLM kept leaving it null. Scott's actual distribution:
   - nurture — 60% (chit-chat, acks, value-delivery to in-program students, friend talk)
   - engagement — 25% (active info-gathering with new ICPs, mystery-teasing, rapport-building)
   - ask — 13% (calendly, scheduling, "ready for our call")
   - awareness — under 1%

2. **`nonsales: True` is the dominant lock**. 65% of corrections set nonsales to true. When true, dm_stage almost always becomes null and sales_stage almost always becomes nurture.

3. **Intent → dm_stage couplings are deterministic when nonsales is false**:
   - close-to-call → send-calendly or offer-call (paired with sales_stage=ask)
   - info-gathering → gather-intel
   - authority-proofing → share-authority
   - value-delivery → frame-outcome
   - community-building → connect or nurture-free

4. **The previous LLM over-used `engagement-nurture`**. Scott's preferred re-classifications:
   - Real question → info-gathering (not engagement-nurture)
   - Talking about own grind/wins/vision → authority-proofing
   - Welcoming or celebrating a community member → community-building
   - Declining or shutting down a topic → redirect

5. **Tone tag philosophy: be specific, not generic**.
   - Add `questions` when the message contains a literal `?`
   - Add `authority` for confident worldview assertions
   - Add `direct` for blunt or curt statements
   - Add `chit-chat` for casual non-business banter
   - Avoid `hype` unless there is real ALL-CAPS energy
   - Avoid `humor` unless something is actually funny

6. **Hard message-level rules that need no LLM**:
   - `audio omitted`, `sticker omitted`, `image omitted`, `Voice call. No answer` — nonsales=true, sales_stage=nurture, dm_stage=null, intent=engagement-nurture, tone=[chit-chat]
   - Calendly link — nonsales=false, sales_stage=ask, intent=close-to-call, dm_stage=send-calendly
   - Google Meet / Zoom link — nonsales=false, sales_stage=ask, intent=close-to-call, dm_stage=offer-call
   - "Ready for our call" / "see you in N minutes/hours" — nonsales=false, sales_stage=ask, intent=close-to-call, dm_stage=send-calendly
   - Single emoji or short ack ("Thanks bro!", "Epic!", "Sweet", "Got it") — nonsales=true, sales_stage=nurture, intent=acknowledgement, dm_stage=null

7. **The current `dm_classified.json` has invalid `dm_stage` values** in the existing AI labels: `value-delivery` (2 rows), `acknowledgement` (5), `redirect` (2), `pre-qualify` (7), `null` as string (4). Those are not in Scott's vocabulary and need to be overwritten.

## Locked-in approach

- **Model**: GPT-4o-mini with stratified few-shots
- **Scope**: All 4,016 Scott messages, except the 183 already in the corrections file (those stay frozen as ground truth wherever they match a row)
- **Strategy**: Hard rules first, then LLM for everything else
- **Output**: Write back into `data/dm_classified.json` in place, after a backup

## Pipeline (`tool_scripts/autotag_dms.js`)

The script already exists in `tool_scripts/autotag_dms.js`. Steps it performs:

1. Load `data/dm_classified.json` and `data/scott_dm_corrections.json`.
2. Group classified messages by `Contact`, sort by `Date`+`Time`.
3. **Match corrections to rows** using full-message exact match, then line-by-line for multi-message replies, with previous-Lead-message disambiguation when multiple candidates exist. Typically yields ~84 matched corrections covering ~130 rows.
4. **Apply Scott's exact tags** to those matched rows. Stamp `scott_validated: true`. These rows never go to the LLM.
5. **Hard-rule pass** on remaining Scott messages: media-omitted, calendly-link, meet-link, call-imminent, emoji-only, short-ack. Stamp `tagged_by: "rule"`.
6. **Build a stratified few-shot pool** from all 183 corrections — round-robin across `(sales_stage, intent, dm_stage, nonsales)` combos, 25 examples total.
7. **LLM pass** for the rest, sending conversation context (previous 5 messages) plus the message to label, with the system prompt embedding Scott's correction-derived rules + the 25 few-shots. Output validated against the strict tag vocabularies; one retry on schema failure; safe fallback if both attempts fail.
8. Save progress every 25 LLM calls so a crash loses at most 25 messages of work.
9. **Backup** `data/dm_classified.json` to `data/dm_classified_backup_pre_autotag.json` before the first write.
10. **Audit log** of every change saved to `tool_scripts/autotag_dms_audit.json`, with samples of frozen, rule, and LLM tagging.

## Modes

```
node tool_scripts/autotag_dms.js                # full run
node tool_scripts/autotag_dms.js --eval         # self-eval against held-out corrections
node tool_scripts/autotag_dms.js --dry-run      # no file writes
node tool_scripts/autotag_dms.js --limit 50     # only N LLM messages (testing)
```

## Self-eval (run before processing the full dataset)

Run with `--eval`. The 25 corrections used as few-shots are excluded; the remaining ~158 are predicted. Reports per-field accuracy and tone-tag Jaccard. Targets:

- sales_stage accuracy: ≥90%
- intent accuracy: ≥85%
- dm_stage accuracy: ≥85%
- nonsales accuracy: ≥95%
- tone-tag Jaccard: ≥0.7

If any field misses its target, refine the system prompt and re-run before doing the full pass.

## How to run on your machine

```
cd C:\Users\santo\Documents\Scott\Scott
node tool_scripts/autotag_dms.js --eval        # validate quality first
node tool_scripts/autotag_dms.js               # then full run
```

Requires:
- `bot/.env` with `OPENAI_API_KEY`
- `bot/node_modules/openai` (already installed)

Approx cost: $1–2 of GPT-4o-mini for ~3,600 LLM calls.

## Output files after a full run

- `data/dm_classified.json` — overwritten with new tags
- `data/dm_classified_backup_pre_autotag.json` — original kept untouched
- `tool_scripts/autotag_dms_audit.json` — every diff, plus samples of frozen/rule/LLM tagging
- `tool_scripts/autotag_dms_eval.json` — self-eval metrics (only after `--eval`)

## Open follow-ups

- Spot-check sample: 30 newly-LLM-labeled messages plus 10 diffs from previously-AI-tagged messages, side-by-side, to manually confirm before treating as final.
- Jae Han alone has 1,373 of the 4,016 Scott messages (34%). Worth a separate pass-through after the run since his conversation patterns will dominate the dataset.
- Sandbox note: when running from this Cowork session the OpenAI SDK needs an HTTPS proxy agent (the script already includes one). On your own machine the proxy code is a no-op.
