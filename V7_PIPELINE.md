# v7 Pipeline — Per-Person Fine-Tune Dataset

Per-person unified-timeline fine-tuning dataset with:

- Scott-only scraping (no wasted work on threads without him)
- Absolute timestamps and canonical Skool slugs
- Gender + company-member tags in the PERSON context block
- `⟨BUBBLE⟩` delimiter so the bot sends DMs as multiple short bubbles instead of one long paragraph
- Cross-channel chronological history per person (DMs + post comments in one stream)

## Files added

| Path | What it does |
|---|---|
| `scraper/scraper_v2.js` | New scraper — Scott-only, all pages, absolute timestamps, slug IDs |
| `bot/bubble.js` | Shared helpers: `splitBubbles`, `collapseBubbles`, `interBubbleDelayMs`, `BUBBLE_DELIM` |
| `data/company_members.json` | Hand-curated team list (Scott + Lea today; add Jack when that account exists) |
| `data/person_overrides.json` | Manual gender/role overrides (gender defaults to male; only add female/unknown here) |
| `tool_scripts/build_persons.js` | Merges slugs, display names, DM contacts, legacy post authors into `data/persons.json` |
| `tool_scripts/build_person_streams.js` | Merges DMs + post comments into `data/person_streams.json` with ordered event timelines |
| `tool_scripts/validate_streams.js` | Gate script: ts parseable, monotonic order, DM count match, gender flags, exclusion flags |
| `tool_scripts/build_v7_jsonl.js` | Emits `data/fine_tune/finetune_data_v7.jsonl` + build report |

## Files modified

| Path | Change |
|---|---|
| `bot/dm_reply.js` | Imports `bubble.js`, splits assistant output on `⟨BUBBLE⟩`, sends each segment as a separate DM bubble with human-variable inter-bubble pauses |
| `bot/auto_reply.js` | Imports `bubble.js`, collapses any `⟨BUBBLE⟩` markers into a single-line reply inside `typeReply` (Skool post comments can't be multi-bubble) |

## Run order

```bash
# 0. Put slug in your scraper .env
#    SKOOL_COMMUNITY_URL=https://www.skool.com/self-improvement-nation-3104
#    TARGET_MEMBER=Scott Northwolf
#    TARGET_MEMBER_SLUG=scott-northwolf
#    SKOOL_EMAIL=...
#    SKOOL_PASSWORD=...

# 1. Fresh scrape — Scott-only, walks every page until "Next" disappears.
#    Community switch: change SKOOL_COMMUNITY_URL and re-run for Synthesizer.
#    Output lands in scraper/output/posts_scott_v2.json
cd scraper
node scraper_v2.js

# 2. Build unified persons list
cd ..
node tool_scripts/build_persons.js

# 3. Build per-person event streams (DM + comments, chronologically ordered)
node tool_scripts/build_person_streams.js

# 4. Validate
node tool_scripts/validate_streams.js
#    If hard-fail, fix before proceeding. Soft-fails are warnings.

# 5. Generate v7 JSONL
node tool_scripts/build_v7_jsonl.js
#    Output: data/fine_tune/finetune_data_v7.jsonl
#            data/fine_tune/v7_build_report.json
```

Re-run steps 2–5 any time `persons.json`, `company_members.json`, or `person_overrides.json` change.

## Decisions locked for v7

| Decision | Value |
|---|---|
| Bubble delimiter | `⟨BUBBLE⟩` (distinct token, unlikely natural collision) |
| Gender default | `male` — overrides live in `data/person_overrides.json` |
| Company-to-company streams | Excluded from training (`excludeFromTraining=true`) |
| Scraping scope | Scott-only filtering on the feed card before thread expansion |
| Pagination cap | 500 pages max (Synthesizer-scale) |
| Timestamp priority | `time[datetime]` → `title`/`aria-label` → derived per-thread offset |

## Gotchas

- **First run without scraper_v2 output.** Builders still work — they use DM + legacy posts. The v7 JSONL will be DM-only until the new scraper populates posts with absolute timestamps.
- **Display-only persons.** Anyone without a slug (because only the legacy scraper has seen them) is keyed as `name:<normalized>`. Re-running `build_persons.js` after a fresh scrape promotes them to slug IDs.
- **masc→female dropouts.** If Scott said "bro" to Lea (or any female person) in historical DMs, those examples are dropped from v7 and listed in `v7_build_report.json.sampleDroppedExamples`. This keeps the PERSON context tag honest during training.
- **BUBBLE in post replies.** If the model emits `⟨BUBBLE⟩` in a post/comment reply, `auto_reply.js` collapses it to a space. The v7 JSONL never trains that case, so this should be rare.

## PERSON block format (what the model sees)

```
--- PERSON ---
Name: Joyce Fortuna
Gender: female
Role: lead (prospect)
--- HISTORY ---
[DM 2026-01-09 10:06] Scott: Hey, Joyce, welcome to Self-Improvement Nation! Glad to have you here.
[DM 2026-01-14 18:53] Scott: Joyce, go ahead, don't be shy, introduce yourself here: ...
--- REPLY TO ---
[DM] Joyce Fortuna: (their message)
```

Role values: `lead (prospect)`, `company-member (ceo)`, `company-member (appointment-setter)`, `company-member (other)`.

## What changed in the bot

DM output `"Hey brother.⟨BUBBLE⟩Tomorrow 3 PM works."` becomes:

```
Hey brother.
(600 ms pause, scaled to next bubble's length)
Tomorrow 3 PM works.
```

Sent as two separate Skool bubbles, with input re-focus between each in case Skool re-renders the textarea.

Post/comment replies stay single-bubble — any stray `⟨BUBBLE⟩` collapses to a space before typing.
