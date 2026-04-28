# Auto-Tagger Improvement Plan

Plan to lift `tool_scripts/autotag_dms.js` accuracy from the current eval ceiling
(intent 41.5%, sales_stage 67.7%, dm_stage 70.8%, nonsales 73.1%, tone Jaccard 0.34)
to a useful production tier (target: intent 70%+, sales_stage 85%+, nonsales 90%+,
tone Jaccard 0.55+).

This document is structured as: (1) the bottlenecks, ranked by how much accuracy
they cost; (2) the fixes, ranked by impact-per-effort; (3) a phased rollout.

---

## 1. What is actually bottlenecking accuracy

The eval saved 30 sample diffs. Walking those, plus the corrections distribution
and the system-prompt code, the failures are not random — they fall into a small
number of structural problems.

### Bottleneck A — The system prompt teaches the wrong answer in places
This is the single most damaging issue and it is invisible in the metrics.

The prompt's "Contrast B" example is verbatim:

> [Scott]: I'm looking forward to it, brother. Infinite gratitude for this moment.
> We both live here now, we are going to be seeing each other a lot...
> Output: { "intent":"acknowledgement", "sales_stage":"nurture", ... }

That exact message exists in `data/scott_dm_corrections.json` as
`correction_id: 7__I_m_looking_forward_to_it_brother_Infi`, and Scott's actual
label is `sales_stage: engagement`, NOT `nurture`. We are explicitly training the
model to emit a label that disagrees with the held-out ground truth.

Several other in-prompt examples (Contrast A "Great, man. I still don't
understand..." → ack, Contrast C "no, bro, the add spent..." → redirect+nurture)
were authored by hand without being checked against the corrections file. Some
agree with Scott, some don't. Until every in-prompt example is sourced from a
real correction row verbatim, the prompt is fighting the eval.

### Bottleneck B — The deterministic post-processor is destroying correct answers
`enforceSalesStage()` (lines 1097–1142) overrides the model whenever:

- `wordCount <= 12 && !msg.includes('?') && model === 'engagement'` → forced to nurture
- `wordCount < 25 && sentenceCount <= 2 && !hasQualifyingQ && !hasCoordination
   && model === 'engagement'` → forced to nurture

Of the 30 sample diffs, **15 are `expected=engagement, predicted=nurture`** —
exactly the failure mode this rule creates. The post-processor is overfit to
"long ack examples should be nurture" and is now zeroing out the model's correct
engagement predictions. This is also why nonsales has a one-sided error pattern
(9 false→true, 1 true→false, 0 of the other direction): the post-processor
flips ask→nurture and that drags nonsales=false→true with it.

### Bottleneck C — Role inference is too aggressive on `in-program-or-personal`
`computeRoleFromContext()` (lines 267–316) labels a contact `in-program-or-personal`
on signals like:

- `scottBroCount >= 2` (Scott uses "bro" twice in 10 messages)
- 5+ Scott messages in the last 10 (active dialogue)
- 3+ Scott + 3+ Lead messages (mutual back-and-forth)

These trigger constantly on prospects Scott is actively qualifying. Once the
role is set, the prompt's "STRONG PRIOR: nonsales=true ~85%" guidance pushes
every subsequent decision toward nurture+engagement-nurture+nonsales=true.

Eval evidence: out of 30 sample diffs, 18 are role=`in-program-or-personal` with
1.78 field-errors per diff, and 10 are role=`unknown` with 2.50 field-errors per
diff. Combined, that's the entire LLM error surface. The LLM is doing what the
prompt told it to do — the prompt's prior is wrong because the role is wrong.

Concrete misfires from the diffs:

- "Siebe, how's business coming along, bro? You've got the methodology already?"
  → Scott labels pain-agitation + engagement + nonsales=false. Role detector
  said in-program-or-personal because of the "bro". Result: nurture, engagement-
  nurture, nonsales=true. Three fields wrong from one bad role.
- "Wow, you got a lot of subs and views... Are you making money with it right
  now? Do you have any high ticket offer?" → info-gathering + engagement +
  nonsales=false. Role: in-program-or-personal. Result: all three fields wrong.

### Bottleneck D — Intent has 13 classes with overlapping definitions and a long tail
Distribution in 183 corrections:

| intent              | count |
|---------------------|-------|
| engagement-nurture  | 62    |
| acknowledgement     | 25    |
| close-to-call       | 17    |
| value-delivery      | 15    |
| info-gathering      | 14    |
| authority-proofing  | 14    |
| community-building  | 12    |
| redirect            | 11    |
| funneling           | 5     |
| pain-agitation      | 2     |
| social-proof        | 1     |
| objection-handling  | 1     |
| lead-qualification  | 1     |

The bottom four have ≤2 examples each. They are statistically unlearnable from
a few-shot prompt, no matter how good the prompt is. The model defaults to the
catch-all (`engagement-nurture`) and we score it as wrong.

Even within the well-populated classes, definitions overlap so much that Scott's
own labels are inconsistent. Examples from the corrections file:

- "What have you come up with so far?" → info-gathering, engagement, nonsales=false
- "Are you still here?" → info-gathering, **nurture**, **nonsales=true**
- "Several… What's the idea?" → info-gathering, **engagement, nonsales=true**

All three are short questions. Three different sales_stage/nonsales combinations.
This puts a hard ceiling on what any model can achieve — the labels themselves
have noise.

### Bottleneck E — Few-shot selection is stratified, not retrieved
50 few-shots is a lot, but they are stratified by `(role × output combo)` once
per run, not per message. The model gets the same 50 examples for "Thanks bro"
and for "Bro, you there? I just had this genius idea...". Most of the 50 are
irrelevant to any given query. With the 8K-ish prompt size we are paying full
context cost for examples that don't help on the specific message.

Worse, several intents (pain-agitation, social-proof, objection-handling,
lead-qualification, funneling) have so few examples they don't survive the
stratification — the model never sees them.

### Bottleneck F — `gpt-4o-mini` is too small for this many overlapping classes
`gpt-4o-mini` was the right choice when the prompt was simple. The current
prompt has six rules, four definition blocks, three contrast sections, 50
few-shots. The model is making coarse decisions because that's what `4o-mini`
is good at. Cost-wise this isn't even close: tagging 4,016 messages with `4o`
is ~$8, with `claude-sonnet-4` is ~$15, with `o4-mini` (reasoning) is ~$5.
Saving $2 by running on `4o-mini` and missing 60% of intent is bad math.

### Bottleneck G — Tone is multi-label but predicted as a single set
`tone_tags` is treated as "pick 1–5 tags from 22". The model picks the obvious
ones (casual, direct, brotherhood, motivational) and misses the long tail
(self-aggrandization, teasing-future-value, mystery-teasing, vulnerability).
`enforceTonePatterns()` patches some of this with regex, but the regex is
brittle and the multi-label nature of the task fits a per-tag binary classifier
much better than a single set-pick prompt.

### Bottleneck H — The eval saves only 30 sample diffs
`runEval()` does `sample_diffs: perFieldDiff.slice(0, 30)`. We can compute per-
class precision/recall in aggregate but cannot inspect every failure to see
which fixes would have caught it. We are debugging blind past message 30.

### Bottleneck I — Inter-annotator agreement is unmeasured
Some of Scott's corrections are inconsistent on near-identical messages (see
Bottleneck D examples). Until we measure how consistent Scott is with himself,
we don't know what the achievable ceiling is. If Scott's intra-annotator
agreement on intent is 75%, no model can score above 75%.

---

## 2. Fixes, ranked by impact per effort

### Fix 1 — Strip the over-correcting post-processor (HIGH impact, LOW effort)

Action: in `enforceSalesStage()`, delete the two soft override blocks that flip
`engagement → nurture`:

```js
// DELETE:
if (wordCount <= 12 && !/\?/.test(msg) && modelStage === "engagement") {
    return "nurture";
}
// DELETE:
if (modelStage === "engagement" && wordCount < 25 && sentenceCount <= 2
    && !hasQualifyingQ && !hasCoordination) {
    return "nurture";
}
```

Keep the hard-signal overrides (Calendly, "let's schedule", media-omitted,
emoji-only, short-ack regex) — those are correct.

Expected lift: sales_stage accuracy +10–15 points based on the 15-of-30 diff
pattern. nonsales lifts in tandem because flipping ask→nurture also flips
nonsales=false→true.

### Fix 2 — Source every in-prompt example from real corrections (HIGH, LOW)

Action: replace the manually-authored "Contrast A/B/C" blocks in
`buildSystemPrompt()` with snippets pulled by `correction_id` from
`data/scott_dm_corrections.json`. For each contrast pair, find a real correction
that demonstrates each side and emit it verbatim.

Specifically the existing Contrast B example is the eval set's diff #1 — that
correction is teaching the model the wrong answer. Replace it with two real
corrections, one labeled `engagement` and one labeled `nurture`, both pulled
from the file.

Expected lift: sales_stage +3–5 points. The teaching contradiction was a
silent regression.

### Fix 3 — Replace stratified few-shots with per-message retrieval (HIGH, MED)

Action: at runtime, for each message, retrieve the K=8 most similar Scott
messages from `corrections.json` (excluding the eval-held-out subset) using
embedding cosine similarity. Pass those as few-shots instead of a fixed 50.

Implementation:
1. Pre-compute embeddings for every correction's `scott_reply` once
   (`text-embedding-3-small`, ~$0.02 total for 183 corrections).
2. At query time, embed the target message, do top-K cosine.
3. Bias toward diversity: enforce the K picks span ≥3 distinct intent classes,
   so the model sees what each candidate label looks like.

This solves two problems at once:
- Rare intents (pain-agitation, info-gathering, redirect) are surfaced when
  the target message is similar to one of the rare examples, instead of being
  starved in stratification.
- The prompt shrinks from ~50 examples to ~8, freeing context for clearer
  rule blocks.

Expected lift: intent accuracy +10–15 points. Tone Jaccard +0.05–0.10 because
the surfaced examples contain similar tone patterns.

### Fix 4 — LLM-based contact role labeling, cached (HIGH, MED)

Action: replace the heuristic `computeContactRole()` and the eval-time fallback
`computeRoleFromContext()` with one LLM call per Contact, cached to disk.

Procedure:
1. For each of the ~370 contacts, build a compact summary: total Scott msgs,
   total Lead msgs, first 3 Scott msgs, last 3 Scott msgs, presence of
   Calendly/Meet/Zoom links, presence of welcome language.
2. Call `gpt-4o` once per contact asking it to pick one of
   {in-program-or-personal, prospect-active, prospect-cold, unknown} with
   reasoning.
3. Save to `data/contact_roles.json`.
4. Auto-tagger reads this file at startup. No more heuristic role detection.

Cost: ~370 × ~600 tokens = ~$0.50 one-time. Re-run when new contacts arrive.

Expected lift: nonsales +10 points. Most of the 9 false→true nonsales errors
trace back to a misclassified role; an LLM with the full conversation summary
will not make those calls. sales_stage +3–5 points (downstream of corrected
priors). intent +3–5 points.

### Fix 5 — Switch the per-message classifier to `gpt-4o` or `claude-sonnet-4` (HIGH, LOW)

Action: change `MODEL = "gpt-4o-mini"` → `MODEL = "gpt-4o"` (or
`claude-sonnet-4`). Cost on 4,016 messages goes from ~$1 to ~$8 — irrelevant
for a one-time tagging pass, and we are going to re-run multiple times during
iteration anyway.

Expected lift: intent +5–10 points across the board. The 4o-mini failure mode
"collapse to engagement-nurture/acknowledgement when uncertain" is a small-
model symptom that goes away at 4o.

### Fix 6 — Decompose the task into three sub-calls (MED, MED)

Action: split `classify()` into three sequential calls:

1. **Call A — Intent only.** Tightly scoped prompt with definition + 6 retrieved
   intent examples. Returns `{intent, reasoning}`.
2. **Call B — Sales-stage / DM-stage / nonsales.** Conditioned on the intent
   from Call A (e.g., if intent=close-to-call, sales_stage is almost always
   ask, dm_stage is offer-call/send-calendly). Returns `{sales_stage, dm_stage,
   nonsales}`.
3. **Call C — Tone tags.** Per-tag binary check across the 22 tones, parallel.

Each call has 1/3 the prompt size, 1/3 the choices, and clearer focus. Total
cost goes up ~2.5×, still pennies.

Expected lift: intent +5 points (focus), sales_stage +5 points (conditioning on
intent), tone Jaccard +0.10 (per-tag binary is the right shape for multi-label).

### Fix 7 — Rule-first intent classification (MED, MED)

Action: before the LLM call, run a pass of regex/lexical rules that fire intent
labels on hard signals. Apply if confidence is high, else send to LLM.

| intent             | hard signal                                                              |
|--------------------|--------------------------------------------------------------------------|
| close-to-call      | Calendly/Meet/Zoom URL, "let's schedule/hop on/jump on/book a call"       |
| community-building | "welcome to the (community / nation / family / brotherhood)"              |
| redirect           | starts with "no", "nah", "I don't", "I'll have to", "I don't think"       |
| acknowledgement    | ≤6 words AND matches `^(thanks|got it|sure|cool|nice|epic|fire|amazing)`  |
| info-gathering     | contains "?" AND `(what are you|where are you at|how much|do you have...)` |
| social-proof       | mentions own income/clients/results to a prospect role                    |
| funneling          | links to community URL or "go check (the / my) (post / channel)"          |

This is roughly the existing `applyHardRules` extended with intent coverage.
Rules apply only when confidence is high; everything else goes to the LLM.

Expected lift: intent +5–10 points (especially close-to-call, redirect,
acknowledgement, community-building — these are easy to rule-detect).

### Fix 8 — Save all eval diffs, not just 30 (LOW, TRIVIAL)

Action: in `runEval()`, change `sample_diffs: perFieldDiff.slice(0, 30)` →
`sample_diffs: perFieldDiff`. Also emit a per-class confusion matrix and per-
role error breakdown into the eval JSON.

Expected lift: 0 (it's a debugging change). But every subsequent iteration is
informed by full failure data instead of the first 30.

### Fix 9 — Collapse / reflow the rare intents (MED, MED)

Action: rare intents (≤2 examples each — pain-agitation, social-proof,
objection-handling, lead-qualification) are unlearnable from current data.
Pick one of:

- (a) **Merge into nearest sibling.** pain-agitation → info-gathering;
  social-proof → authority-proofing; objection-handling → redirect;
  lead-qualification → info-gathering. Document the merge so downstream
  consumers know.
- (b) **Demote to a binary "advanced sales move" flag.** Drop them from the
  primary intent enum, add an `advanced_intent` field that is null for 95% of
  messages and a rare-class label for the remaining 5%. Train a separate
  one-vs-rest classifier later when we have ≥20 examples per class.
- (c) **Hand-collect 20 more examples per rare class.** Cheapest gain on
  recall for those specific moves but costly in human time.

Recommended: (a) for now, plan (c) over the next two weeks.

Expected lift: intent +3–5 points (we stop being scored against unlearnable
labels). Cleaner downstream.

### Fix 10 — Per-tag binary tone classifier (MED, MED)

Action: replace the "pick 1–5 from 22" tone prompt with 22 parallel binary
prompts ("Does this message exhibit `<tone>`? yes/no, with a 1-line reason").

Implementation: batch all 22 binary calls into one prompt that returns 22
yes/no answers (still one API call per message). Cost stays the same. Output
format is now well-suited to the multi-label structure.

Drop `enforceTonePatterns()` regex enforcement — let the model do its job
when the format actually fits.

Expected lift: tone Jaccard +0.10–0.15.

### Fix 11 — Measure inter-annotator agreement (MED, LOW)

Action: pick 30 corrections randomly. Send them back to Scott as fresh items
to label without showing his prior labels. Measure Cohen's kappa between his
two passes per field.

If intent kappa is ≤0.65, intent ground truth has ~30% noise — model accuracy
is bounded by that. Report what the achievable ceiling is so the team has
realistic expectations.

If kappa is ≥0.80, the labels are clean and the model truly is the bottleneck.

This is not a fix that lifts the metric, but it tells us what's worth chasing.

### Fix 12 — Active-learning loop (LOW, MED)

Action: every eval run, dump the 30 worst diffs (highest field-error count)
to `tool_scripts/autotag_eval_review_queue.csv`. Have Scott label-or-confirm
those. Add to corrections file. Re-run eval. Repeat weekly.

Each pass adds 30 high-leverage labels (the ones the model is currently
fooled by) and tightens the few-shot retrieval pool.

Expected lift: 1–2 points per iteration, compounding. Right thing to do
even after the other fixes ship.

### Fix 13 — Consider a fine-tune (LOW for now, HIGH effort)

Action: once corrections grow to ~500 high-quality examples, fine-tune
`gpt-4o-mini` directly on this task. The fine-tuned model can be tiny because
it only does one job (5-field tag prediction).

Don't do this yet. The corrections set is too small (183) and label noise is
unmeasured (Fix 11). Fine-tuning on 183 noisy labels will overfit to the
noise. Revisit after Fixes 1–11 are in.

---

## 3. Phased rollout

### Phase 1 — Same-day, no new infrastructure (Fixes 1, 2, 5, 8)
- Strip the over-correcting `enforceSalesStage` soft overrides.
- Replace in-prompt Contrast A/B/C examples with verbatim corrections.
- Switch `MODEL` to `gpt-4o`.
- Save full eval diffs and emit per-class confusion matrix.
- Re-run eval; baseline expected: intent ~55%, sales_stage ~80%, nonsales ~85%.

### Phase 2 — One-time data prep (Fixes 4, 9)
- Build `data/contact_roles.json` via one-time LLM labeling pass.
- Decide on rare-intent collapse policy and apply to corrections file.
- Wire role file into `autotag_dms.js`. Drop heuristic role detection.
- Re-run eval; expected: intent ~62%, sales_stage ~85%, nonsales ~92%.

### Phase 3 — Architecture change (Fixes 3, 6, 7, 10)
- Implement per-message embedding retrieval for few-shots.
- Decompose into Intent → Stages → Tone three-call pipeline.
- Add rule-first intent classification with a confidence gate.
- Per-tag binary tone classifier.
- Re-run eval; expected: intent ~75%, sales_stage ~88%, tone Jaccard ~0.55.

### Phase 4 — Continuous improvement (Fixes 11, 12)
- Run inter-annotator agreement once.
- Wire active-learning review queue into the weekly cycle.
- Once corrections > 500, evaluate Fix 13 (fine-tune).

---

## 4. What NOT to do

- **Do not add more rules to `enforceSalesStage` / `enforceTonePatterns`.**
  Every override added so far has fixed one failure mode and created two new
  ones. The post-processor is the source of more errors than the model.

- **Do not raise `NUM_FEWSHOTS` above 50.** More few-shots will not help while
  selection is stratified — the marginal example is still random. Per-message
  retrieval (Fix 3) is the right move; with retrieval, K=8 will outperform the
  current 50.

- **Do not expand the 22-tone vocabulary.** Several existing tones already
  overlap (casual ↔ chit-chat, hype ↔ motivational, brotherhood ↔ bonding-
  rapport). Adding more makes Jaccard worse, not better. Consider collapsing
  pairs in a future cleanup.

- **Do not fine-tune yet.** 183 corrections with unmeasured label noise is
  exactly the regime where fine-tuning overfits to bad labels. Earn the right
  to fine-tune by getting clean corrections to 500+ first.

---

## 5. Expected end-state

After Phases 1–3:

| metric        | current | target |
|---------------|---------|--------|
| sales_stage   | 67.7%   | 88%    |
| intent        | 41.5%   | 72%    |
| dm_stage      | 70.8%   | 85%    |
| nonsales      | 73.1%   | 92%    |
| tone Jaccard  | 0.34    | 0.55   |

These are realistic for a 13-class intent task with imperfect labels and a
smart per-message retrieval pipeline. The intent ceiling specifically is
bounded by Bottleneck I (label consistency); we cannot meaningfully exceed
Scott's own intra-annotator agreement and that number is currently unknown.

The core insight: the eval is failing not because the model is too small, but
because the surrounding system (post-processor, role detector, in-prompt
examples) is fighting against ground truth. Fix the system first, then judge
the model.
