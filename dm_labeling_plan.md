# DM Labeling Plan — Scott's Authentic Tagging Pipeline

## Context

Scott has manually corrected 183 Pre-labeled DM tags (in `scott_dm_corrections.json`). The goal is to use these corrections to label ALL the DMs in `dm_classified.json` in the most Scott-authentic way possible — by extracting common patterns from his corrections and applying them across the full dataset.

---

## What the data looks like

- **scott_dm_corrections.json**: 183 corrections. All of them changed at least one tag, none were no-ops.
- **dm_classified.json**: 8,638 messages across 370 contacts. 4,016 are Scott's. Of those, 1,992 already have AI-suggested tags, 2,024 are completely untagged.

---

## Patterns Scott applies (extracted from his 183 corrections)

### 1. The dominant fix: sales_stage was almost always missing

Scott had to fill in `sales_stage` in 140 of 183 corrections (76%). The LLM kept leaving it null. Scott's actual distribution:

| sales_stage | count | when |
|---|---|---|
| nurture | 110 (60%) | chit-chat, acknowledgements, value-delivery to in-program students, friend talk |
| engagement | 45 (25%) | active info-gathering with new ICPs, mystery-teasing, building rapport |
| ask | 24 (13%) | calendly, scheduling, "ready for our call" |
| awareness | 1 | rare first-touch |

### 2. nonsales=True locks the rest of the row

When Scott marks `nonsales: True` (which he does for 65% of corrections), the row almost always becomes: `sales_stage: nurture`, `dm_stage: None`. The LLM kept assigning sales-pipeline stages to friend-banter / voice-call / sticker / "Thanks bro!" messages. Scott bumps those to nonsales.

### 3. Intent → dm_stage couplings are deterministic

From the corrected combos:

- `close-to-call` → `ask` + `send-calendly` or `offer-call` + `nonsales: False` (ALWAYS)
- `info-gathering` (sales) → `engagement` + `gather-intel`
- `authority-proofing` (sales) → `engagement` or `nurture` + `share-authority`
- `value-delivery` (sales) → often `frame-outcome`
- `acknowledgement` → almost always `nurture` + `None` + `nonsales: True`

### 4. Intent re-classifications: LLM over-uses "engagement-nurture"

Scott's pattern is to be more specific:

- Real question being asked → `info-gathering`, not `engagement-nurture`
- Scott talking about his own vision/grind/track record → `authority-proofing`
- Welcoming/celebrating a community member → `community-building`
- Declining or shutting something down → `redirect`

### 5. Tone tag preferences (28 corrections)

Scott adds: `questions` (if it has a `?`), `authority`, `direct`, `curiosity`, `chit-chat`, `motivational`. He removes: `hype` when not actually hyped, `humor` when nothing's funny, `curiosity` when there's no real curiosity. The LLM was sprinkling generic energy tags.

### 6. Hard message-level rules I can extract

- `"audio omitted"` / `"Voice call. ‎No answer"` / `"sticker omitted"` → nonsales=True, nurture, None, engagement-nurture
- Contains calendly link → ask + close-to-call + send-calendly + nonsales=False
- `"ready for our call in X"` / `"see you in X minutes"` → ask + close-to-call + send-calendly|offer-call
- Single emoji or `"Thanks bro!"` / `"Epic!"` → nurture + acknowledgement + None + nonsales=True

### 7. Already-tagged file has invalid values

The 1,992 already-AI-tagged messages contain `dm_stage` values that aren't in Scott's vocabulary at all: `value-delivery` (2), `acknowledgement` (5), `redirect` (2), `pre-qualify` (7), `null` (4). Those need overwriting too.

---

## Proposed plan

### Phase 1 — Build the "Scott pattern" labeling pipeline

Create `tool_scripts/label_dms_with_scott_patterns.py`:

1. **Load + group**: read `dm_classified.json`, group by `Contact`, sort by `Date`+`Time`. For each Scott message, build a context window of the previous 5–8 messages (Lead + Scott alternating).
2. **Hard-rule pass** (handles ~30–40% deterministically): regex/string rules from pattern 6 above. Skip LLM for these.
3. **LLM classification pass** for the rest, using:
   - System prompt with the exact Scott-derived rules above (sales_stage triggers, intent→stage coupling, tone-tag philosophy)
   - 25–30 stratified few-shot examples sampled from the 183 corrections (one per `(sales_stage, intent, dm_stage, nonsales)` combo)
   - User prompt: the conversation context + the message to label
   - Strict JSON output, validated against allowed values per field
4. **Validation pass**: re-run any output that fails schema validation; flag anything where a second model disagrees.

### Phase 2 — Self-eval against the 183 corrections

Run the pipeline on the 183 corrected messages and measure agreement with Scott's `new_tags`. Target ≥90% on each field. If it misses, refine the prompt and re-run before touching the rest.

### Phase 3 — Label all 4,016 Scott messages

Run the validated pipeline. Output `data/dm_classified_v2.json` plus an audit log (`data/dm_classified_changes.json`) showing every diff vs the original — so nothing gets silently overwritten.

### Phase 4 — Sample review

Pull 30 random newly-labeled messages and 10 from the previously-tagged set with diff, present in a side-by-side for you to spot-check before treating it as final.

---

## Locked-in plan (after confirmation)

Based on answers: GPT-4o-mini + fat few-shots, all 4,016 Scott messages but freeze the 183 corrected ones, hard rules first → LLM, write back into `data/dm_classified.json`.

### Step 1 — Build `tool_scripts/autotag_dms.js`

Mirrors the structure of the existing `autotag_person_streams.js`:

- Loads `data/dm_classified.json` and `scott_dm_corrections.json` (drop the corrections file in `data/` first).
- Iterates Scott messages; for each, builds a context window of the previous 5–8 in-conversation messages (grouped by `Contact`, sorted by `Date`+`Time`).
- Resume-safe: skips if already labeled with `scott_validated: true` or matches a correction_id.
- Saves progress every 25 messages.
- Writes `data/dm_classified_backup_<date>.json` first, then overwrites `data/dm_classified.json`.

### Step 2 — Freeze the 183 corrected messages

Match each correction to the corresponding row in `dm_classified.json` (by `scott_reply` text + nearest timestamp), inject `new_tags` directly, and stamp `scott_validated: true`. These never go to the LLM.

### Step 3 — Hard-rule pass (free, deterministic)

Runs before any LLM call. Rules from the corrections:

| pattern | tags |
|---|---|
| `audio omitted` / `Voice call.*No answer` / `sticker omitted` / `image omitted` | nonsales=True, sales_stage=nurture, dm_stage=None, intent=engagement-nurture, tone=[chit-chat] |
| Contains a calendly link | nonsales=False, sales_stage=ask, intent=close-to-call, dm_stage=send-calendly |
| `ready for our call` / `see you in \d+ (min\|hour)` | nonsales=False, sales_stage=ask, intent=close-to-call, dm_stage=send-calendly |
| Single emoji or `Thanks bro!` / `Epic!` / `🔥` / ≤3 words pure ack | nonsales=True, sales_stage=nurture, intent=acknowledgement, dm_stage=None |
| Google Meet link | nonsales=False, sales_stage=ask, intent=close-to-call, dm_stage=offer-call |

Expected coverage: ~30–40% of messages, free.

### Step 4 — LLM pass for the rest (GPT-4o-mini)

System prompt packs:

1. Tag vocabularies (the exact allowed values from the corrections, no extras).
2. Scott's correction rules in plain English (the seven patterns I extracted).
3. Intent→stage coupling matrix (deterministic mappings).
4. 25 stratified few-shot examples sampled from the 183 corrections — one per `(sales_stage × intent × dm_stage × nonsales)` combo, weighted toward the most common combos.

User prompt for each message: conversation context + the message + "Output JSON with these exact fields".

Output is JSON-validated against allowed values per field; on failure, retry once. On second failure, fall back to a safe default and flag in the audit log.

### Step 5 — Self-eval before touching the full dataset

Run the pipeline on the 183 corrected messages without using them in few-shots (leave-one-out style). Measure agreement per field.

Targets:
- sales_stage ≥90%
- intent ≥85%
- dm_stage ≥85%
- nonsales ≥95%
- tone tags Jaccard ≥0.7

If any miss, refine prompt and re-run before processing the other ~3,800 messages.

### Step 6 — Run on all 4,016 Scott messages

~$1–2 of GPT-4o-mini cost. Resume-safe, with backup. Writes:

- `data/dm_classified.json` (overwritten with new tags)
- `data/dm_classified_backup_2026-04-26.json` (untouched original)
- `data/autotag_dms_audit_log.json` (every diff, plus the few-shots used and any retries)

### Step 7 — Final spot-check

Pull a sample of 30 newly-labeled messages + 10 diffs against the original AI labels and present them side-by-side for review before treating it as final.

---

## Three things worth flagging before starting

1. **Jae Han alone has 1,373 messages (34% of all Scott DMs).** Whatever patterns are weird about that one conversation will dominate. I'll process him in a single contiguous batch so context stays consistent, but flagging in case you want to spot-check him separately.
2. **The 183 corrections file**: I'll need it copied to `data/scott_dm_corrections.json` in the repo so the script can reference it (currently only in uploads).
3. **Few-shot selection**: I'll pick 25 examples from the corrections. That removes 25 from the eval set — leaving 158 for self-eval. Acceptable, but if you'd rather I sample from a held-out set let me know.

---

## Open question

Want me to start executing this, or would you like to tweak anything first?
