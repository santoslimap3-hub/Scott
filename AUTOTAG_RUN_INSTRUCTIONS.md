# Autotag DMs — Run Instructions

The pipeline is built. The sandbox can't reach OpenAI, so you run it locally. Two commands.

---

## Step 1 — Validate the prompt against Scott's ground truth (~2 min, ~$0.05)

Open a terminal in `C:\Users\santo\Documents\Scott\Scott` and run:

```
node tool_scripts/autotag_dms.js --eval
```

This holds out the 158 corrections that aren't in the few-shot set, asks GPT-4o-mini to label them, and reports per-field accuracy.

**What you'll see at the end:**

```
=== EVAL REPORT ===
sales_stage acc: XX.X%
intent acc:      XX.X%
dm_stage acc:    XX.X%
nonsales acc:    XX.X%
tone Jaccard:    0.XX
Wrote .../tool_scripts/autotag_dms_eval.json
```

**Targets** (from the plan):
- `sales_stage` ≥ 85 %
- `nonsales` ≥ 95 %
- `dm_stage` ≥ 80 %
- `intent` ≥ 75 %
- `tone Jaccard` ≥ 0.70

If accuracy looks good, proceed to Step 2. If it misses badly, paste the report back to me here and I'll tune the prompt.

---

## Step 2 — Full run on all 4,016 Scott messages (~25–40 min, ~$1–2)

```
node tool_scripts/autotag_dms.js
```

What it does, in order:
1. **Backup** original `dm_classified.json` → `dm_classified_backup_pre_autotag.json` (only if backup doesn't already exist).
2. **Freeze** 130 messages whose tags Scott corrected by hand (`scott_validated: true`).
3. **Hard rules** — instantly label ~270 messages: calendly links, voice/sticker, single-emoji ack, "ready for our call" etc. Free, deterministic.
4. **LLM pass** — ~3,616 remaining Scott messages → GPT-4o-mini with the 25 stratified few-shots and Scott's seven correction rules.
5. **Save every 25 messages** so a crash doesn't lose progress (resume-safe — re-running skips anything already tagged).
6. **Audit log** → `tool_scripts/autotag_dms_audit.json` (samples of every category).

**You'll see progress like:**

```
Plan: frozen=130 rule=270 llm=3616 (skipped already done=0)
Running LLM on 3616 messages (concurrency=6)...
  llm progress: 25/3616 (1%)
  llm progress: 50/3616 (1%)
  ...
DONE. Final stats: {"frozen":130,"rule":270,"llm_pending":3616,"llm_done":3616,"skipped_already_done":0}
```

Safe to interrupt with Ctrl-C — re-run picks up where it left off.

---

## Optional — Smaller test run before committing

If you want to spot-check the LLM before burning $1–2:

```
node tool_scripts/autotag_dms.js --limit 50
```

Labels only 50 LLM-bound messages, writes them back, you can eyeball `data/dm_classified.json` and the audit log. Then re-run without `--limit` to finish the rest (it skips anything already tagged).

---

## What gets written

| File | What |
|---|---|
| `data/dm_classified.json` | Updated in place — every Scott message gets `tone_tags`, `intent`, `sales_stage`, `dm_stage`, `nonsales`, plus `tagged_by` (`scott`/`rule`/`llm`) and `scott_validated` (true if frozen from corrections) |
| `data/dm_classified_backup_pre_autotag.json` | Untouched original snapshot |
| `tool_scripts/autotag_dms_audit.json` | Run stats + 50-each samples of frozen/rule/LLM tags + which corrections couldn't be matched |
| `tool_scripts/autotag_dms_eval.json` | Eval-mode report (only if you ran `--eval`) |

---

## When done

Tell me here in chat: "eval done — paste numbers" or "full run done". I'll then:
- Pull a stratified sample of 30 newly-labeled + 10 diffs against the prior AI labels
- Show them side-by-side for your spot-check
- Confirm the tag distribution matches Scott's correction histogram (more `nurture`, less `engagement`)

---

## Heads-up — 95 corrections didn't match

Of your 183 corrections, only 84 matched messages in the current `dm_classified.json` (covering 130 messages, since some corrections span multi-line replies that landed across multiple rows). The other 95 are corrections to messages from a different/older DM source that's no longer in this file. They're still useful — all 183 feed the eval and few-shot pool — but they don't get applied as frozen tags. Audit log lists them under `unmatched_correction_ids`.
