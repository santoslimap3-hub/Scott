# auto_reply.js v1 Rebuild Plan

A clean rebuild of the Skool post-reply bot, focused on lead generation workflow first, code structure second. The current `auto_reply.js` is 2,507 lines with three layered LLM calls and three programmatic override chains per item. v1 strips it down to two LLM calls per cycle (one batched classifier + up to three generations) and one clear sales workflow.

---

## What's actually broken from the lead-gen side

The current bot acts like a content-engine that happens to be selling. It's not behaving like an appointment setter. An appointment setter does five things: stay visible to the right people, spot the right leads, make a single high-quality first touch, move warm leads to DM, and keep trust by responding when engaged. The current bot only does the first one well, and it does it too much.

Specific issues when you read the loop as a sales workflow:

**Volume is suspicious.** 3–7 posts plus 10–20 comments per cycle, every cycle, on a single account. A real human-run setter account does maybe 1–3 quality replies a session. The current cap looks like spam to anyone watching the feed and to Skool's own ranking signals.

**Wrong targets get replies.** "Advice" posts where the author isn't a coach get replies. "Other" posts (wins, intros, memes) are filtered out, but "advice" stays in the slot allocation. From a lead-gen view, replying to a non-coach asking general advice is wasted reach — they're not buying Scott's offer.

**Replies try to do too many sales jobs at once.** The intent-tag system has 13+ intents (`engagement-nurture`, `lead-qualification`, `value-delivery`, `close-to-call`, etc.). Real sales playbook on a public post is binary: either you're giving free value to plant authority, or you're hooking curiosity so they come to DM. Pitching publicly is wrong in both cases. The 13 intents collapse into 2 once you ask "what's the move?"

**No author-level cadence.** Bot replies to the same person multiple times because `replied_posts.json` keys by post URL, not by author. If Bob posts twice this week, the bot publicly comments twice. A real setter would reply once publicly, then DM Bob the second time he posts — because he's now warm.

**Hot-leads queue is fed reflexively, not by judgment.** Anyone classified as ICP or hot gets dumped into the DM queue. The DM bot then opens a cold DM regardless of whether the public reply got a like, a reply, or anything at all. The DM should be a follow-up to engagement, not a parallel cold touch.

**Notification handling is bolted on.** Notifications (the highest-signal events — someone replied to us, someone @-mentioned us) are checked on a coin-flip between items and at cycle start. From a sales view, those should be the FIRST thing handled every cycle, before any new outreach. They're literally warm leads pinging us.

**Public replies and DMs use the same persona prompt and the same tag system.** They're different conversations. A public reply is one sentence to plant a seed in front of an audience. A DM is a one-on-one qualification chat. Trying to use the same `intent`/`stage` taxonomy for both is what produces the awkward "shoot me a DM brother" CTAs in public posts that read as bot-scripted.

**No measurement of whether replies work.** The training log captures every reply for fine-tuning later, but there's no feedback loop within the running bot — did the reply get a like, a thread response, a DM? Without that, every cycle is blind.

---

## What's broken from the code side

The reply pipeline for a single post currently goes:

1. `classifyPosts` — LLM call #1, returns `category_class` (hot/icp/advice/other) + `urgency 0-10`.
2. `tag_classifier` — LLM call #2 (gpt-4o-mini), returns `tone_tags`, `intent`, `sales_stage`, `gender`, `reasoning`.
3. `deriveStageFromHistory` — programmatic override: "DB beats classifier", forces `sales_stage` based on prior interaction count.
4. If new stage is `ask`, force `intent = close-to-call`.
5. If `category_class === "hot"`, force `intent = close-to-call` AND `sales_stage = ask` — overrides #3.
6. Build a system prompt that injects all those tags into a base model that was never trained on them.
7. `generateReply` — LLM call #3, with a system prompt containing VOICE rules, RULES rules, PERSON CONTEXT rules, MULTIPLE MESSAGE BUBBLES rules (irrelevant on posts), conditional CTA GUIDE block, plus the four tags.
8. After generation, post-process: strip `⟨BUBBLE⟩` markers because the system prompt told the model it could use them in DMs.

By the time the reply is generated, classifier #2's output is basically meaningless for any item that matters — hot posts always get `close-to-call`/`ask` regardless of what the classifier said, and known persons always get a derived stage regardless of either classifier.

Other smells: `openPostAndGetBody` and `scrapePostContext` are duplicate scrapers (~150 lines each, near-identical body extraction). Six persistent files written per cycle (`replied_posts.json`, `hot_leads_queue.json`, persons DB, post-classifications DB, session log MD, training log JSON). The notification handler is a 400-line mini-bot of its own with ~50 lines of debug logging hard-coded inline.

The contradiction: the project doc describes a "Mother AI + fine-tuned model" architecture, but the bot is using vanilla `gpt-4o` with prose-stuffed system prompts to *simulate* what the fine-tuned model would do. So all the tag scaffolding is paying for nothing.

---

## The v1 lead-gen workflow

Throw out the "classify everything, score everything, override everything" frame. Replace it with a workflow that mirrors what an appointment setter actually does in a single sitting on Skool.

### What the bot is for, in one sentence

Be a credible Skool presence inside Scott's ICP communities, surface the right 1–3 prospects per session, and hand them off to DM with the lightest possible public touch.

### The cycle, sales-first

Every cycle, in this order:

**Phase 1 — Respond to engagement (highest priority).** Open notifications. For every unread item where a real person replied to one of our comments or @-mentioned us, that's a warm signal. Reply to those first, before anything else this cycle. Then for each person who engaged, queue a DM follow-up — because they've now interacted with us twice (their post → our reply → their reply), which is the actual qualification threshold for a DM.

**Phase 2 — Find one to three ICP posts.** Scrape the feed. Run a single classifier pass that returns one of three labels per post: `ignore`, `value` (post by an ICP — a coach showing struggle or asking how to grow — but no buying signal), or `hook` (explicit buying signal: asking for mentorship, ready to invest, asking how to find a coach, etc.). No urgency scores, no tone tags, no enum proliferation. Just three buckets that map directly to a sales action.

**Phase 3 — Reply with the right move, only.**

For `value` posts: a short, useful insight in Jack's voice. Plants authority. **No CTA, no DM hook.** Two to three sentences. The goal is for other ICPs reading the thread to think "this guy gets it" — that's how warm DMs come in unprompted later.

For `hook` posts: a short curiosity reply that ends with one line inviting DM. One question, one hook, never desperate. The goal is to convert visible buying intent into a DM thread Scott can run with.

Cap the cycle at three of these, total. If the feed only has one good ICP post that day, do one and end the cycle. Discipline beats volume.

**Phase 4 — Skip comments-on-other-people's-posts entirely in v1.** Replying to comments under random people's posts is high-cost (browser plumbing, double-reply risk) and low-signal (you're commenting on someone commenting). Reintroduce in v2 if engagement data justifies it.

**Phase 5 — Author-level dedup.** Ledger keyed by author, not by post URL. If we've publicly replied to this person in the last 7 days, don't reply again — queue them for DM instead. This single change kills the spammy double-reply pattern.

**Phase 6 — DM queue is a judgment call, not a reflex.** Three things put a person in the DM queue: a `hook` reply was sent (clear buying signal), a person engaged back with us in notifications (active interest), or a known person posted again (returning warm lead). ICP-without-buying-signal posts do NOT auto-queue — let the public reply do its job and let them come to us, or let the next cycle decide based on whether they engaged.

### What this means for the AI surface

Two LLM calls per cycle, total — not three per item.

**Call 1 — Triage classifier (one call, batched).** Input: list of feed posts. Output per post: `{label: "ignore" | "value" | "hook", reason: "<=12 word note"}`. That's the entire classifier. No urgency, no tone, no stage, no gender, no intent enum.

**Call 2 — Generator (one call per reply, max 3 per cycle).** Input: post body + author + `label` + `reason`. The label selects between two micro-prompts hardcoded in `generate_reply.js`:

- `value` prompt: "Reply in Jack's voice with a short useful insight. Two to three sentences. No questions, no CTA, no DM hooks."
- `hook` prompt: "Reply in Jack's voice. Two sentences max. End with one open question or one short DM invite. Never desperate."

The persona block (Jack's voice) is one short paragraph, identical for both, no conditional CTA section, no `STAGE`/`INTENT`/`TONE` lines, no bubble-delimiter rules, no person-context block. The fine-tuned model gets swapped in later by changing one config line.

---

## File layout

```
bot/
  auto_reply.js          // the cycle loop, ~250 lines
  skool_browser.js       // login, getAllPosts, openPost, typeReply, submitReply, notifications
  triage.js              // Phase 1 notif handling + Phase 2 batched classifier
  generate_reply.js      // two prompt templates, one OpenAI call wrapper
  replied.json           // ledger keyed by author: {name, lastRepliedAt, lastLabel, threadHref}
  hot_leads_queue.json   // DM queue with one-line reason per entry
  .env
```

No `classify/`, no `db/`, no `logger/`, no `prompt_builders/`, no `bubble.js`, no `util/gender_detector.js`. If a future version needs them, they get added back deliberately.

---

## What gets deleted vs kept vs shelved

### Deleted in v1
- `tag_classifier` and the entire tone/intent/stage/gender system
- `deriveStageFromHistory` and all override chains
- Hot/ICP/advice/other × urgency 0-10 scoring
- Author profile scraper (the bio inject is a nice-to-have, not v1)
- Bubble delimiter handling
- `post_classifications_db` cache
- `training_log` JSON (skip until there's a model to retrain)
- `dm_reply.js` auto-coupling — v1 only writes the queue file, you trigger DMs manually until that's tuned
- Comment-on-other-people's-posts pipeline
- Multi-community rotation (run one community well first)

### Kept (mechanics, not AI)
- Login, feed scraping, post body extraction, top-level reply typing, notification bell click, mark-as-read
- `replied.json` but rekeyed by `{author, lastRepliedAt}` instead of by post URL
- `hot_leads_queue.json` but only fed by the three explicit triggers above

### Shelved for v2+
- Like-as-presence (silently liking ICP posts you don't reply to — boosts visibility, costs nothing)
- Per-reply outcome tracking (did the reply get a like back, a thread response, a profile visit) — feeds a real learning loop
- Author bio injection for `hook` replies only
- Comment-on-other-people's-posts (only after v1 conversion data justifies it)
- Posting original content as Jack (real authority play, but a different bot)
- Reintroducing tone/intent tagging — but only inside DMs, where the conversation actually has stages

---

## Cadence

Cycle every 30–60 minutes during human-active hours, not continuously. A bot replying within 90 seconds of a post going up looks robotic. Add a per-post randomized delay of 3–15 minutes before responding so replies land naturally. Pause overnight.

---

## What success looks like for v1

Three numbers to watch in the first week:

1. **Reply yield** — of the public replies sent, how many got a like or thread response within 24h. Target ≥ 40% on `value` replies, ≥ 60% on `hook` replies.
2. **DM queue quality** — of the names queued for DM, how many turn into actual two-way DM conversations once the DM bot reaches them. Target ≥ 50%.
3. **Account safety** — zero shadow-bans, zero "you're posting too much" warnings. The 1–3 cap and per-author dedup exist to make this trivially true.

If the yield is low, the fix is the prompt and the classifier — small surface, one place to look. If queue quality is low, the fix is the `hook` classifier threshold. If safety drops, lower the cap. Each lever moves one thing.

---

## Migration order

1. Rename current `auto_reply.js` to `auto_reply_legacy.js`, keep it runnable.
2. Build `skool_browser.js` by extracting only the Playwright functions that work today: `login`, `getAllPosts`, body extraction from `openPostAndGetBody`, top-level `typeReply`, Path B of `submitReply`, notification bell + mark-read.
3. Build `triage.js` (Phase 1 notifications + Phase 2 batched classifier).
4. Build `generate_reply.js` (two prompt templates, one OpenAI call).
5. Build the new `auto_reply.js` cycle that wires Phase 1 → 2 → 3 → 5 → 6.
6. Run dry — no submit clicks — for one full cycle on Hope Nation. Eyeball every classifier label and every generated reply.
7. Live for one cycle. Cap at 1 reply that day. Read the output thread the next morning.
8. Loosen the cap to 3 once the first live reply lands clean.

---

## Reusable code from the legacy file

The Playwright mechanics work. Extract these into `skool_browser.js`:

| Legacy function | Lines | Status |
|---|---|---|
| `login()` | 245–296 | reuse as-is |
| `getAllPosts()` | 298–358 | reuse as-is |
| Body extractor inside `openPostAndGetBody` | 458–537 | reuse, drop the comments-extraction branch |
| `typeReply()` top-level path | 864–947 | reuse, drop `inlineTarget` branches |
| `submitReply()` Path B (COMMENT button) | 1032–1042 | reuse |
| `hasUnreadNotifications` + `clickNotificationBell` + `markNotificationRead` | 1681–1770 | reuse, simplify |

Everything else — the tag classifier module, the persons DB, the post classifications DB, the session log, the training log, the bubble helpers, the gender detector, the profile scraper, the comment scraper, the comment classifier, the inline reply box finder, the `clickCommentReplyButton` evaluate block, the 400-line `handleNotifications` — stays in `auto_reply_legacy.js` until v2 has a use case for any of it.
