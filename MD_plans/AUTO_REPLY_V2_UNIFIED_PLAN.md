# auto_reply.js v2 — Unified Outreach Bot Plan

A rebuild of `bot/auto_reply.js` that merges DM handling into the same loop, replaces volume-based posting with a value-flex targeting model, runs every person through one explicit appointment-setting workflow, and stops the bot from blurting weird replies to "thank you" notifications.

The plan is shaped by patterns observed in `data/manual_person_streams.json` (70 streams that ended in Scott sending his Calendly link).

---

## 1. What Scott actually does (data-driven)

Pulled from the 70 calendly-ending streams in `manual_person_streams.json`:

- **31/70** streams begin with public engagement (post or comment) before any DM. The other 39 are DM-first (welcome flows, hot leads, returning members).
- **47/70** of the first DMs are sent BY Scott — he is not a passive inbox; he opens DMs after a good public exchange or when he sees a hot post.
- **Median 3 Scott DMs and 4 lead DMs before the calendly drops.** It's a quick funnel: most flows are 4–10 messages total once a real conversation starts.
- **Public comments are pure value or affirmation, not CTAs.** Out of the entire dataset, only 3 public comments by Scott contain anything resembling "DM me." The other ~thousand are short, philosophical, brotherhood-coded, no hook.
- **The calendly drop is short and confident.** Variations of "let's just schedule a call: \<link\>" or "Awesome, let me know when you've scheduled it: \<link\>". No long pitch.

The bot's current `auto_reply.js` does the opposite of all four: it pumps volume on the public side, pitches DMs publicly, has no continuity between public ↔ DM, and treats every notification as something to write back to.

---

## 2. The single workflow per person

One state machine, one source of truth (the persons DB). Every action — public reply, DM reply, link drop — is gated on which stage that person is in.

```
STAGE 0  unseen
   |
   |  bot replies publicly to one of their posts/comments
   v
STAGE 1  value-planted          (we said something useful in public, no CTA)
   |
   |  they respond publicly with substance OR react/reply 2x
   v
STAGE 2  publicly-warm           (they've engaged back, threshold for DM-pivot)
   |
   |  bot opens DM with a specific reference to the public exchange
   |  OR the lead opens DM first
   v
STAGE 3  dm-opened
   |
   |  1-3 DMs of qualification: what coaching, where stuck, what they want
   v
STAGE 4  dm-qualified            (we have enough context to invite a call)
   |
   |  bot floats a call: "we should jump on a quick call"
   v
STAGE 5  call-offered            (lead said yes / asked for the link)
   |
   |  bot drops calendly + a one-line warm close
   v
STAGE 6  calendly-sent
```

Stage transitions only happen on hard signals, not vibes:

| From → To | Trigger |
|---|---|
| 0 → 1 | bot sent a public reply, no error |
| 1 → 2 | partner posted ≥1 substantive reply back to our comment, or @-mentioned us, or DM'd us |
| 2 → 3 | DM thread exists with both sides having sent at least one message |
| 3 → 4 | classifier says we have answers to: (a) what they coach / what they want to coach, (b) what they're stuck on |
| 4 → 5 | bot has sent a call invitation that the partner has said yes to (or asked for the link) |
| 5 → 6 | calendly link sent and confirmed in DOM |

Stage is stored in `bot/db/persons.json` next to each person. The bot reads stage at the top of every action and behaves differently per stage, instead of running 13 intent enums.

---

## 3. The unified cycle

Every cycle, in this order — the DM sweep is folded in next to the notifications check, since both are inbound-warm-signal work and they share the chat-panel UI plumbing.

```
launchBrowser → login (once)

while (true):
    PHASE 1  inbound sweep (notifications + DMs)
    PHASE 2  feed scrape and triage
    PHASE 3  public replies (max N per cycle)
    PHASE 4  outbound DM opens (people newly promoted to stage 2)
    PHASE 5  cycle summary + sleep
```

### Phase 1 — Inbound sweep

The current bot only checks notifications at the top of the cycle, and DMs are in a different process. The new cycle does both as one inbound pass.

```
1. Open notifications bell
2. Read notification items, mark all read
3. For each engagement notification (someone replied/mentioned us):
     a. PRE-CLASSIFIER decides: REPLY | ACK | NO_REPLY
        (this is the fix for the "thank you" weirdness — see §6)
     b. If REPLY: full engagement reply via fine-tuned model
     c. If ACK:   short emoji or 1-3 word brotherhood ack
     d. If NO_REPLY: do nothing, leave on read
     e. Update the partner's stage in persons DB:
        - if they were stage 1 → bump to stage 2 (publicly-warm)
        - if they were stage 0 → set stage 1 with their post as anchor
4. Open chat panel (DM list)
5. Read conversation list, find threads where last message is from partner
6. For each pending DM:
     a. Read full conversation
     b. Classify DM stage (3 / 4 / 5) using the existing dm_classifier
     c. PRE-CLASSIFIER (same one as notifications): REPLY | ACK | NO_REPLY
     d. If REPLY: generate stage-aware DM reply
        (stage 3 = qualify; stage 4 = float call; stage 5 = drop calendly)
     e. If ACK / NO_REPLY: short or silent, exactly like notifications
7. Close chat panel
```

The DM logic is lifted from current `dm_reply.js` — the chat panel plumbing, conversation reading, bubble splitting, human-typing, persons DB writes — and pulled into `bot/dm_sweep.js` so the cycle calls it as one function.

### Phase 2 — Feed triage (value-flex targeting)

This is where the post-selection logic changes. Old triage used `value | hook | ignore`. New triage adds an explicit *value-flex* score and is opinionated about what counts.

Per post, the LLM returns:

```json
{
  "label": "value-flex" | "hook" | "ignore",
  "topic": "discipline" | "money-mindset" | "client-acquisition" | "offer-creation"
         | "self-image" | "sales-call" | "habits" | "coaching-philosophy"
         | "general" | "off-topic",
  "flex_score": 0-3,    // 0 = nothing useful to add, 3 = bot has clear high-value insight
  "reason": "<= 12 words"
}
```

`label` definitions, opinionated:

- **value-flex** — Post is in the bot's wheelhouse: self-improvement or coaching or business growth, AND the bot can plausibly add something the room would screenshot. Coach struggling with offer pricing. Person stuck on first client. Question about discipline, identity, sales calls. The author does NOT need to show a buying signal — this is authority planting.
- **hook** — Author is showing explicit buying intent (asking for a coach, ready to invest, "how do I find someone who…"). Rare, ~2–10% of posts.
- **ignore** — Anything else: wins, intros, memes, replays, generic life updates, posts where the bot has nothing distinctive to add (`flex_score` < 2).

The classifier sees the post body **and** a one-line description of what the bot actually knows well, so its filter for "can we flex here" is grounded:

```
Bot expertise: how solo coaches go from $0 to $10K/month, offer creation,
client acquisition without ads, sales call frameworks, identity-based
self-improvement, daily systems, the inner game of high performance.
```

### Phase 3 — Public replies

Cap: **3 per cycle, hard.** Prefer `hook` first, then `value-flex` sorted by `flex_score` desc.

For each picked post:

- Author cooldown applies — if they're already at stage ≥ 2 we don't reply publicly again, we open a DM instead (Phase 4).
- If author is at stage 1 with our last reply still unanswered, skip — don't double-touch publicly.
- Reply prompt is one of two templates:

**value-flex prompt** (most common):
```
You are Jack Walford. Reply to a post in the community.
This person is at stage 0/1 with us — they don't know us yet.
Plant authority by saying ONE specific, useful thing about <topic>.
Two or three sentences. No questions. No CTA. No DM hook.
Brotherhood voice. Address them by their last name once.
```

**hook prompt** (rare, only on explicit buying signals):
```
You are Jack Walford. Reply to a post where the author asked for help/a coach.
Two sentences max. End with one open question.
Do NOT pitch. Do NOT mention a call. Do NOT say "DM me."
The point is a thread reply that makes them want to reach out themselves.
```

Note: even the `hook` template has no "DM me" line. Scott does not write that. The hook is an *open question* in the thread that pulls them into a public sub-thread, which then trips the stage 1 → 2 promotion next cycle when they reply, which then triggers the bot to open the DM in Phase 4.

### Phase 4 — Outbound DM opens

A real shift from the current bot. Today, anything classified hot reflexively dumps into the DM queue, which makes the DM bot send cold opens.

New rule: bot only opens a DM with someone in stage 2 (publicly-warm). Three concrete triggers feed stage 2:

1. They replied substantively to our public comment.
2. They @-mentioned us in a notification.
3. They are a returning member who posted again after we already replied to them in the past 14 days.

When the cycle hits Phase 4, it pulls everyone newly promoted to stage 2 since the last cycle and sends one DM opener apiece. Cap: **2 outbound opens per cycle**.

The opener follows Scott's pattern (from `manual_person_streams.json` — Paul Miller, David Radamm, Michael Haertinger): **specific reference to the post or thread, one curiosity question, no pitch, no link**. The fine-tuned model is fed the public exchange as context.

Once sent, the person moves to stage 3 (dm-opened) and any further activity flows through the DM sweep in Phase 1 next cycle.

### Phase 5 — Cycle summary + sleep

Same as today: log counts, sleep 30–60 min. Add per-person stage changes to the cycle summary so it's visible what moved where.

---

## 4. The Calendly drop — what triggers it

From the calendly streams, the link drop is gated on a **lead-side signal**, not an LLM mood. The bot only sends the link when one of these is in the last 1–2 partner messages:

- "let's chat" / "let's talk" / "I'm down" / "yes" / "let's do a call"
- "do you have a calendly?" / "send me a link" / "where do I book"
- a direct yes after the bot has floated a call

If the partner has not given that explicit green light, the bot stays in stage 4 and asks one more qualifying question instead. This rule is enforced in code (regex + a tight LLM check), not left up to the generation model — that's the only way to stop premature link drops.

The drop message itself is short and warm — three working templates pulled from the data:

```
Awesome, let me know when you have scheduled it so I can confirm it landed
on my calendar: <link>
```
```
Let's just schedule a call so we don't keep missing each other: <link>
```
```
Amazing, brother. Here's my link: <link>
```

The model picks the closest one based on the partner's energy. After the drop the person moves to stage 6 and stays out of the bot's outbound queue for 14 days regardless of activity (don't follow up before Scott has done the call).

---

## 5. Better post and comment selection

Three concrete changes vs. the current `triage.js`:

**Add a flex-score floor.** Reject any `value-flex` candidate with `flex_score < 2`. The bot should leave posts where it has nothing distinctive to add. This is the single biggest fix for "why is the bot replying to that?"

**Topic-grounded prompt.** The classifier prompt names the bot's actual expertise (offer creation, client acquisition, sales calls, identity work, daily systems). Posts about gym splits, gear reviews, generic memes get scored 0 even if they're vaguely "self-improvement coded."

**Author-history features in the prompt.** Pass the persons DB summary for each post's author into the classifier so it knows: have we replied before? are they at stage 1+? did they engage back? — same person re-asking the same question gets de-prioritized; a stage-2 person posting again gets routed to Phase 4 (DM open) instead.

Same logic for comments-on-our-replies (this is what the notification handler is doing): pre-classify the comment for substance before generating. Low-effort comments are a different surface than feed posts and need their own prompt — covered in §6.

---

## 6. The "weird reply to thank you" problem

This is the failure pattern: someone says "thank you Daniel" or drops a 🔥, and the bot replies with a long, philosophical, awkward message that screams bot. Or worse, it replies "you're welcome" wrapped in three sentences of brotherhood preamble.

The fix is a small **PRE-CLASSIFIER** that runs on every inbound short-text message — in both the notification handler and the DM handler — before the generator is called. It's cheap (gpt-4o-mini, single call, batched if multiple) and outputs one of three actions:

```
{
  "action": "REPLY"     // generate full reply via fine-tuned model
        | "ACK"          // emit one of: short emoji ("🔥"), brief ack ("anytime, brother"), or mirror
        | "NO_REPLY",    // leave on read, mark notif read, do nothing
  "ack_template": "emoji" | "mirror" | "brotherhood-2word" | null,
  "reason": "<= 8 words"
}
```

Decision rules baked into the classifier prompt:

- **NO_REPLY** when: emoji-only ("🔥", "💯", "👍", "❤️"); single word ("facts", "fr", "💯", "🤝"); generic gratitude with nothing new ("thank you", "ty", "appreciate it"); the conversation has naturally closed; the partner already said something resembling goodbye.
- **ACK** when: gratitude with a sliver of substance ("thank you, that was helpful"); short reaction that deserves a small mirror ("damn that's deep" → "🔥 brother"); a one-liner that the bot would look weird ignoring but doesn't need a paragraph.
- **REPLY** when: there's a real question, a story, a substantive disagreement, a follow-up that opens the conversation, or any partner message ≥ ~12 words with content.

Critical detail: the bot **always marks the notification as read**, even on NO_REPLY. The partner is not waiting for an answer; the bot is the one who's been treating "thank you" as homework.

Default ratios on borderline cases — to keep the bot from looking like it must respond to everything:

- Gratitude-only with no substance: NO_REPLY 70%, ACK 30%.
- Emoji-only: NO_REPLY 90%, ACK 10% (the 10% being a mirror of the same emoji).
- One-word agreement ("facts", "fr"): NO_REPLY 80%, ACK 20%.

ACK templates (hardcoded — do NOT pass to the model, this is what makes the current bot weird):

```
emoji:               "🔥"  |  "💯"  |  "🙏"
mirror:              echo the partner's emoji ("👊" if they sent "👊")
brotherhood-2word:   "anytime, brother"  |  "all love"  |  "🔥 brother"  |  "you got it"
```

The pre-classifier picks `ack_template`; the bot prints exactly that string. The fine-tuned model is bypassed. This is the only way to guarantee the response doesn't "explain itself."

The same pre-classifier also runs on DMs — the existing `[NO_REPLY]` mechanism in `dm_reply.js` is good but is a *post-generation* decision (the model is asked to consider returning `[NO_REPLY]`), which costs a full generation call and sometimes fails. Moving it to a pre-classifier saves cost and is more reliable.

---

## 7. File layout

```
bot/
  auto_reply.js          // single unified cycle, ~350 lines
                         // entry point, runs Phase 1 → 5 forever

  skool_browser.js       // login + feed scrape + post body + reply submit
                         // + notification bell (kept from v1)

  dm_sweep.js            // DM list scan, conversation read, reply send
                         // (extracted from dm_reply.js, no own loop)

  triage.js              // batched feed classifier with flex_score + topic
                         // + pre-classifier for short inbound messages

  generate_reply.js      // value-flex prompt, hook prompt, engagement prompt,
                         // dm-stage prompts (qualify / float-call / drop-link)
                         // each returns {system, user} for the model

  ack_templates.js       // hardcoded short reactions used on ACK actions
                         // (emoji, mirror, brotherhood-2word lookup)

  classify/
    pre_classifier.js    // REPLY / ACK / NO_REPLY router (gpt-4o-mini, cheap)
    dm_classifier.js     // existing — refines DM stage 3/4/5

  db/
    persons.js           // existing — adds stage field per person
                         // helper: getStage, setStage, promote(person, toStage)

  state/
    replied.json         // ledger keyed by author (already exists)
    hot_leads_queue.json // existing, but only fed by stage-2 promotions
```

`dm_reply.js` becomes deprecated — kept as `dm_reply_legacy.js` for one week as a fallback while the unified cycle bakes in.

---

## 8. New environment variables

```
# unified cycle caps
MAX_PUBLIC_REPLIES_PER_CYCLE=3
MAX_DM_REPLIES_PER_CYCLE=5
MAX_OUTBOUND_DM_OPENS_PER_CYCLE=2

# the calendly link to drop
CALENDLY_URL=https://calendly.com/northwolfscott/meeting

# pre-classifier model (cheap)
PRE_CLASSIFIER_MODEL=gpt-4o-mini

# main generation model
GENERATION_MODEL=ft:...   # eventually the fine-tuned one

# on/off for the calendly auto-drop — start with false until it's bulletproof
ALLOW_CALENDLY_AUTO_DROP=false
```

---

## 9. Migration order

1. **Build `pre_classifier.js`.** Wire it into the existing `auto_reply.js` engagement handler and `dm_reply.js` DM handler. Test it on a corpus of past notifications + DMs from the persons DB. This single change kills the "thank you" weirdness without touching anything else.
2. **Add `stage` field to persons DB and write the promote() helpers.** Backfill existing persons by inferring stage from their interaction history. No behavior change yet.
3. **Rewrite `triage.js`** to return `flex_score` + `topic`. Wire the floor (`flex_score >= 2`) into the post selection logic in `auto_reply.js`. Run dry for one cycle, eyeball labels.
4. **Extract `dm_sweep.js`** from `dm_reply.js`. Make the unified `auto_reply.js` call notifications-then-DMs in Phase 1.
5. **Add Phase 4 outbound DM opens** gated on stage 2. Cap at 1 for the first week.
6. **Add the calendly drop guard** (lead-side green-light regex + LLM check) and wire to a single drop template. Keep `ALLOW_CALENDLY_AUTO_DROP=false` until 5+ live drops have been hand-reviewed and look like Scott would have sent them.
7. **Retire `dm_reply.js`** once the unified loop has run for 3 days clean.

---

## 10. What success looks like

Same three numbers as v1, plus two:

1. **Public reply yield** — share of replies that get a like or partner-reply within 24h. Target ≥ 40% on `value-flex`, ≥ 60% on `hook`.
2. **DM queue quality** — share of stage-2 promotions that turn into a 3+ message DM thread. Target ≥ 60%.
3. **Account safety** — zero "you're posting too much" warnings, no shadow-bans.
4. **Stage progression** — share of stage-3 conversations that reach stage 4 within 7 days. Target ≥ 30%.
5. **Acknowledgement-handling** — share of inbound short-text messages where the bot's response (or non-response) reads like Scott. Hand-reviewed weekly until the pre-classifier's confusion matrix stabilises.

If yield is low → fix prompt or `flex_score` floor.
If queue quality is low → tighten stage 1 → 2 promotion rules.
If stage 3 → 4 stalls → DM stage classifier needs more data.
If safety drops → cap reductions.
If the bot still sounds weird on "thank you" → expand the pre-classifier ACK templates and lower the REPLY share on borderline cases.

Each lever moves one thing.
