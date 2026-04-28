# DM Auto-Tag — Eval Round 2 Plan

## Where we are

| Metric             | Baseline | Round 1 | Δ          |
|--------------------|----------|---------|------------|
| sales_stage acc    | 66.9%    | **52.3%** | −14.6% (regressed) |
| intent acc         | 36.8%    | **43.1%** | +6.3%      |
| dm_stage acc       | 75.9%    | **76.9%** | +1.0%      |
| nonsales acc       | 75.9%    | **72.3%** | −3.6% (regressed)  |
| tone Jaccard       | 0.29     | **0.33**  | +0.04      |
| rule hits          | 12/133   | **14/130**| +2 (call-pitch rule firing) |
| LLM "unknown" role | 56/132   | **29/116**| Big improvement (role-passing bug fixed) |

Two metrics regressed even though the diagnosis was correct. The fix overshot.

## What's actually happening (round 1 confusion-matrix in sample diffs)

`sales_stage`:
- `(nurture, engagement)` = **17 errors** — the new rule pushed the model too far toward `engagement`
- `(engagement, engagement)` = 7 (correct, was wrong before)
- `(engagement, nurture)` = 1 (was 12 before — that direction is fixed)

`nonsales`:
- `(True, False)` = 7 errors — the model is now predicting `nonsales=false` for in-program contacts when Scott says `true`
- `(False, True)` = 3 errors

`intent`:
- `(engagement-nurture, acknowledgement)` = 4 (was 10 — fixed substantially)
- `(acknowledgement, engagement-nurture)` = 5 (new error — flipped the other way)
- `(engagement-nurture, value-delivery)` = 3 (new error — model now over-uses value-delivery for in-program)
- `(acknowledgement, value-delivery)` = 2 (new error — same root cause)

## Root cause

Round 1 made three changes that interacted badly:

1. **"Substantive multi-sentence → engagement"** was too loose. Scott's actual prior is nurture 60% / engagement 25% / ask 13%. The new rule made the model treat anything past a one-liner as `engagement`, but Scott labels two-sentence casual banter as `nurture`. The decision boundary needs to be much higher than "more than one sentence".

2. **Removing the "in-program → nonsales=true ALMOST ALWAYS" framing** weakened the strongest prior we had. The old prose was right — Scott's empirical rate of `nonsales=true` for in-program contacts is ~80%+. By softening it, the model now flips 7/30 in-program messages to `nonsales=false`.

3. **Telling the model "value-delivery / info-gathering / authority-proofing CAN happen with in-program"** combined with point (2) caused the model to start over-using `value-delivery` (5 new errors) for in-program contacts — exactly the opposite problem we were trying to fix in round 0.

The previous anti-pattern was wrong about volume but right in spirit: those intents *do* happen with in-program contacts but they're rare (value-delivery+nonsales=true = 10/183 = 5.5%). The new prose treats them as on-the-table everywhere.

## Plan — round 2 fixes

### Fix 1 (highest impact): tighten engagement criteria

Replace the loose "multi-sentence → engagement" rule with a tighter, signal-based one. `engagement` requires at least one of:

- A question Scott is asking the recipient about THEM (not rhetorical) AND the contact is a prospect / cold / unknown
- Coordinated planning across people ("you can send it to Lea", "I'll talk to X tomorrow about Y")
- 40+ words of substantive content (not 15)
- An active multi-turn dialogue visible in context (3+ Scott msgs + 3+ Lead msgs in last 15)

Otherwise `nurture` is the default. Update RULE 3 prose accordingly with explicit examples that look "long" but are still nurture (long voice-note paraphrases, philosophical musings, life updates without coordination).

Expected impact: removes ~13–15 of the 17 `(nurture, engagement)` errors → +10% sales_stage.

### Fix 2: restore strong nonsales=true default for in-program-or-personal

Reinstate the empirical prior: in-program-or-personal → `nonsales=true` ~85% of the time. Keep the carve-out (explicit upsell on a NEW offer) but make the default sticky.

Change role-guidance text back to: "nonsales=true is the default and should be flipped only if Scott is explicitly closing/upselling THIS recipient on a new offer. Discussing business topics is NOT enough."

Expected impact: fixes 5–7 of the `(True, False)` errors → +4-5% nonsales, +small dm_stage (since dm_stage gets nulled when nonsales=true).

### Fix 3: dampen value-delivery / info-gathering / authority-proofing for in-program

Reverse the "CAN happen" prose into a calibrated probability statement: "These intents *occasionally* occur with in-program contacts (~5% each) but are MUCH rarer than engagement-nurture (~50%), acknowledgement (~25%), or redirect (~10%) for those contacts. Only pick value-delivery / info-gathering / authority-proofing when the message is unmistakably teaching / qualifying / authority-flexing — not for any explanatory or curious message."

Expected impact: fixes 3–5 of the `*-> value-delivery` errors → +3-4% intent.

### Fix 4: add deterministic sales_stage post-processor

Mirror `enforceTonePatterns` for `sales_stage`. After the LLM returns, override based on hard text signals:

```
if message contains Calendly / "schedule a call" / "are you home for our call" → ask
elif message ≤ 12 words AND no '?' → nurture (force-down from engagement)
elif message is voice-note / sticker / image-only → nurture
elif message is single-emoji or short ack pattern → nurture
elif explicit question to a prospect-active OR prospect-cold → engagement
else: keep model's prediction
```

Expected impact: covers the bottom-half of `(nurture, engagement)` errors that the prompt change can't reach.

### Fix 5: re-tune the acknowledgement boundary

Round 1 over-corrected. New rule: acknowledgement is the right intent when the message's PRIMARY function is to confirm/agree/react, even if it has 1-2 follow-up sentences. The boundary should be:
- ≤ 5 words → almost always acknowledgement
- 6–15 words with a thank-you/agreement opener AND no question → acknowledgement
- 16+ words OR contains a question → engagement-nurture or more specific

Add 3 new few-shot examples explicitly contrasting these cases.

Expected impact: fixes the 5 `(acknowledgement, engagement-nurture)` errors → +4% intent.

### Fix 6: better tone enforcement — add `acknowledgement` to enforceTonePatterns when applicable, dampen `motivational` over-prediction

The current `enforceTonePatterns` only ADDS tones, never REMOVES. Add a small dampening pass: if the model returns `motivational` but the message is < 8 words and is a pure ack, drop `motivational` (it's an over-default).

Expected impact: small Jaccard improvement (~+0.02).

### Fix 7: stratify few-shots by ROLE × intent (not just output combo)

Currently few-shots are stratified by `(sales_stage, intent, dm_stage, nonsales)` — that's 4-way output stratification. We're also implicitly running 4 different problems (one per role) and the few-shots may not represent each role.

Switch to a 2-level stratification: first ensure ≥6 few-shots per role bucket (in-program-or-personal, prospect-active, prospect-cold, unknown), then within each bucket stratify by output combo. This needs us to compute the role for each correction (we already do via `contactByCorrectionId` for matched ones; for unmatched fall back to `computeRoleFromContext`).

Expected impact: better in-context calibration per role → +2-4% across the board.

## Validation strategy

After each fix is applied, re-run `run_autotag_eval.bat` and compare to the baseline + round 1 numbers. Target end-state:

| Metric          | Baseline | Round 1 | Round 2 target |
|-----------------|----------|---------|----------------|
| sales_stage acc | 66.9%    | 52.3%   | **≥ 78%**      |
| intent acc      | 36.8%    | 43.1%   | **≥ 60%**      |
| dm_stage acc    | 75.9%    | 76.9%   | **≥ 82%**      |
| nonsales acc    | 75.9%    | 72.3%   | **≥ 85%**      |
| tone Jaccard    | 0.29     | 0.33    | **≥ 0.45**     |

If after this round we're still short, the next levers are (a) switch the classify model from gpt-4o-mini to gpt-4o for harder cases, (b) bigger few-shot count, (c) chain-of-thought prompting.

## Execution order

1. Fix 1 (engagement criteria) + Fix 2 (nonsales default) + Fix 3 (intent calibration) — three prompt edits in one pass, eval.
2. Fix 4 (sales_stage post-processor) + Fix 6 (tone dampening) — code edits, eval.
3. Fix 5 (acknowledgement boundary + 3 new few-shots) + Fix 7 (role-stratified few-shots) — eval.

Stop after each pass and check whether we hit targets before proceeding.
