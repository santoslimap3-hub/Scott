# Plan — Relabel `dm_classified.json` in Scott's authentic voice

> Source of truth for "authentic" = the **111 manual corrections** Scott made in `data/dms/scott_dm_corrections.json`. Everything below is derived from diffing `previous_tags → new_tags` across those 111 records.

---

## 1. What Scott actually corrected (the patterns the LLM was getting wrong)

### Headline finding: **`sales_stage` is the most-broken field**

| Field          | % of corrections that touched it |
| -------------- | --------------------------------: |
| `sales_stage`  | **71.2 %** (79 / 111) |
| `tone_tags`    | 21.6 % (24 / 111) |
| `intent`       | 10.8 % (12 / 111) |
| `dm_stage`     |  8.1 %  (9 / 111) |
| `nonsales`     |  4.5 %  (5 / 111) |

### 1.1  `sales_stage` — fill the empties, prefer `nurture`

The LLM was leaving `sales_stage = ""` whenever it had decided `nonsales = true`. Scott rejects that — **every Scott message has a sales_stage**, even casual chats.

| Flip                          | Count | Meaning |
| ----------------------------- | ----: | ------- |
| `"" → nurture`                | 43 | Default for casual / post-call / friendship / chit-chat |
| `"" → engagement`             | 15 | Active interest-building (questions, frame-outcome, sharing wins) |
| `nurture → engagement`        |  7 | Not as friendly as the LLM thought — Scott is actively building interest |
| `"" → ask`                    |  7 | Calendly, "ready for our call?", meet links |
| `engagement → nurture`        |  4 | Not as salesy as the LLM thought — it's just relationship maintenance |
| `nurture → ask` / `ask → nurture` | 3 | Edge nuance |

**Rule of thumb for Scott:**
- `awareness` → first contact / brand-new lead. Used very rarely.
- `nurture` → *default* for any casual, post-call, friend-mode, or community-building message. **This is the most under-used label.**
- `engagement` → Scott is probing, framing the outcome, painting transformation, or actively raising interest.
- `ask` → he's pointing at Calendly, confirming a call time, or sending a meet link.

### 1.2  `nonsales` + `dm_stage` are coupled

5 corrections flipped `nonsales: false → true` (LLM was over-classifying friendship as sales). Every time, `dm_stage` was set to `null`.

**Rule:** `nonsales = true ⇔ dm_stage = null`. If a message is about food, family, social events, post-purchase logistics, or pure relationship maintenance → `nonsales: true, dm_stage: null` — but **still give it a `sales_stage` (almost always `nurture`)**.

### 1.3  `dm_stage` — Scott's official vocabulary

Only these 7 values appear in Scott's corrected `dm_stage`:

```
connect | gather-intel | frame-outcome | share-authority |
offer-call | send-calendly | nurture-free
```

Plus `null` (for `nonsales: true`). The current `dm_classified.json` contains LLM-invented stages (`pre-qualify`, `value-delivery`, `acknowledgement`, `redirect`, `null` as a string) — **these are noise** and should be normalised.

### 1.4  `intent` — Scott's official vocabulary

```
acknowledgement | engagement-nurture | info-gathering | close-to-call |
redirect | value-delivery | authority-proofing | community-building |
funneling | pain-agitation | social-proof | objection-handling
```

Scott's corrections never produced `lead-qualification` (which appears 11× in current data) — likely a rename / merge into `info-gathering`.

Notable intent flips:
- `acknowledgement → engagement-nurture` (×2): when Scott isn't just confirming but is also asking a follow-up or pulling the thread forward.
- `engagement-nurture → redirect` (×1): when he's pivoting away.
- `engagement-nurture → info-gathering` (×1): when there's an explicit question.
- `engagement-nurture ↔ authority-proofing` (×2): nuance around expert positioning.

### 1.5  `tone_tags` — what Scott adds and removes

```
ADDED     +questions ×5  +authority ×3  +curiosity ×2  +chit-chat ×2
          +direct ×2  +motivational ×2  +bonding-rapport  +praise
          +self-aggrandization  +humor  +gratitude  +casual  +supportive-helpful
REMOVED   -hype ×1  -questions ×1  -curiosity ×1  -humor ×1
```

Strong signals:
- **Any `?` in the message → add `questions`.** This is the single most reliable rule (5 of 5 add-cases).
- **Declarative / opinionated / "this is how it is" tone → add `authority`.**
- **`humor` and `hype` are over-used by the LLM** — only keep them when the message is actually a joke or actually high-energy.

Full tone vocabulary observed in Scott-corrected tags:

```
acknowledgement, authority, bonding-rapport, brotherhood, casual, chit-chat,
curiosity, direct, empathy, gratitude, humor, hype, motivational, mystery-teasing,
praise, questions, self-aggrandization, storytelling, supportive-helpful,
teasing-future-value, tough-love, vulnerability
```

---

## 2. Current state of `dm_classified.json`

```
8 638 total messages in 370 contacts
4 016 Scott messages
  ├── 1 992 already have ai_suggested tags (the LLM pass Scott was correcting)
  └── 2 024 are entirely untagged   ← biggest job
4 365 Lead messages   (no tagging needed — Scott only tags his own replies)
  257 Participant 1/2/Night Hawk    ← unclassified speakers, need handling
```

The current LLM bias (vs. Scott's corrected distribution):

| Field         | LLM distribution                                 | Scott's actual taste |
| ------------- | ------------------------------------------------ | -------------------- |
| `sales_stage` | 55 % engagement, 16 % nurture, 24 % ask, 4 % awareness | 54 % nurture, 32 % engagement, 12 % ask |
| `intent`      | 35 % acknowledgement, 14 % info-gathering        | 36 % engagement-nurture, 15 % acknowledgement |
| `nonsales`    | 60 % false, 40 % true                            | 68 % true, 32 % false |

→ The LLM is **over-calling sales** (too much "engagement"/"acknowledgement", too little "nurture"). Re-labelling has to drag the distribution toward Scott's centre.

---

## 3. Relabeling method (proposed)

Three layers, run in order, so cheap rules catch the easy cases and the LLM only burns tokens on the hard ones.

### Layer A — Deterministic rules (~30 % coverage, free, perfect precision)

Run these regex/keyword passes first. They override anything else when they fire.

| Trigger                                                                 | Output                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Message contains `calendly.com/`                                        | `dm_stage: send-calendly, intent: close-to-call, sales_stage: ask`    |
| Message contains `meet.google.com` / `zoom.us` / `cal.com`              | `dm_stage: send-calendly, intent: close-to-call, sales_stage: ask`    |
| Regex: `ready for (our|the) call`, `see you in \d+`, `our call in \d+`  | `dm_stage: offer-call, intent: close-to-call, sales_stage: ask`       |
| Message contains `?`                                                    | add `questions` to tone_tags                                          |
| First Scott message ever to a contact AND mentions `welcome` / `glad to have you` | `dm_stage: connect, intent: community-building, sales_stage: awareness` |
| Message links to `skool.com/.../inauguration` or `.../say-hello-`        | add tone `bonding-rapport`, `dm_stage: nurture-free`, `intent: community-building` |
| Pure logistics (one of: "i'll send", "tomorrow", "address", "check", "paypal", "invoice") with no questions and no offer | candidate for `nonsales: true, dm_stage: null` (LLM confirms)         |

These rules come straight out of the corrections (e.g. "I'll see you in 9 minutes, bro" → `send-calendly + ask`).

### Layer B — Retrieval-augmented LLM pass (the rest, ~70 %)

For every Scott message not fully resolved by Layer A:

1. **Build context window:** the message itself + the last 6 messages of the thread (alternating Lead/Scott), plus the contact's name and the position-in-conversation (1st Scott reply? mid-thread? after-call?).
2. **Retrieve k = 8 most similar correction examples** from `scott_dm_corrections.json` using TF-IDF over the *Scott reply text + last lead message*. (Re-use `rag/retrieval.js` — already in the repo.)
3. **Prompt the LLM** (Claude Haiku 4.5 — fast and cheap, 4 016 calls is trivial) with:
   - **System prompt** containing:
     - Scott / Jack persona summary (lifted from `bot/classify/tags.js`).
     - The Section 1 rubric above, condensed.
     - Strict vocabulary lists for each field.
     - The hard rule that `nonsales=true ⇒ dm_stage=null`, AND `sales_stage` is *always* set.
   - **Few-shot block** with the 8 retrieved corrections shown as `(context, message) → new_tags` (NOT previous_tags — we only show Scott's corrected answer).
   - **Plus 4 anchor examples** hard-coded: one per `sales_stage` (awareness / nurture / engagement / ask) drawn from the cleanest corrections.
   - **User message** = the Scott message + its 6-message context, asking for a JSON object with the 5 fields.
4. **Validate** the output against the closed vocabularies. On invalid → retry once with stricter prompt → on second failure fall back to a deterministic default (`nonsales: true, dm_stage: null, intent: acknowledgement, sales_stage: nurture, tone_tags: ["casual"]`).

### Layer C — Post-pass cleanup

After Layers A + B:
- Drop any `dm_stage` value not in the official 7 (or `null`).
- If `nonsales = true` but `dm_stage ≠ null` → force `dm_stage = null`.
- If `sales_stage` is empty / null → set to `nurture`.
- Always ensure `tone_tags` includes `questions` if message contains `?`, `direct` if message ≤ 6 words.
- Strip `hype` and `humor` unless message contains `!!`/`🔥`/`fuck`/`LMAO`/`😂` (high-energy markers).

---

## 4. Validation harness (do this before running on all 4 016)

Before touching the full file, hold-out the 111 corrections themselves and grade:

1. **Hold-out test:** pretend we don't know Scott's `new_tags`. Run Layers A + B on each correction's `last_10_messages + scott_reply`. Compare predicted tags to `new_tags`.
2. **Per-field accuracy targets** (these are floors, the real bar is 'feels right'):
   - `sales_stage` ≥ 85 %
   - `nonsales` ≥ 95 %
   - `dm_stage` ≥ 80 %
   - `intent` ≥ 75 %
   - `tone_tags` ≥ 70 % token-level F1
3. **Distribution check** on the full 4 016 after a dry run — the resulting histogram should look like Scott's correction histogram, not the LLM's current bias. (Sec. 2 table.)
4. **Spot-check 50 random reclassified messages by hand** before promoting the result.

---

## 5. Deliverables

```
data/dms/
  ├─ scott_label_rubric.md            # the Section 1 rubric, polished, version-locked
  ├─ relabel_dm_classified.py         # the pipeline (rules + retrieval + Claude)
  ├─ relabel_eval.py                  # the hold-out grader (Sec. 4)
  ├─ dm_classified_relabeled.json     # final output — same schema as dm_classified.json
  └─ dm_classified_relabel_report.md  # per-field stats + 50 spot-check samples
```

Original `dm_classified.json` is left untouched; the new file is a sibling so we can A/B.

---

## 6. Cost & time estimate

- 4 016 Scott messages × Claude Haiku ≈ **$1 – $2** total, ~30 minutes wall-time with batching.
- Engineering effort: rubric polish (1 h) → eval harness on 111 hold-out (2 h) → pipeline (2 h) → full run + spot-check (1 h). **~6 hours.**

---

## 7. Open decisions for you

1. **Lock the vocabularies.** Should `lead-qualification` (11 in current data, 0 in corrections) be auto-renamed to `info-gathering`, or kept as a 13th intent?
2. **Participants 1/2/Night Hawk (257 msgs).** Skip, or run a re-classification pass on those first?
3. **Already-tagged Scott messages (1 992).** Re-tag everything (recommended — Scott corrected the LLM and its biases will still be in those tags), or only fill the 2 024 untagged?
4. **Welcome / first-DM detection.** Use `Date` + `Contact` to find each contact's first Scott message and force `dm_stage: connect`?
5. **Ground-truth growth.** Want me to extend the rubric every time you correct another batch of tags, so the model gets sharper over time?

Send back which of those you want, and I'll start with the eval harness on the 111 hold-out.
