# auto_reply.js — Agentic Rework Plan

A rebuild of `bot/auto_reply.js` so that an Anthropic LLM (not hardcoded heuristics) decides what to engage with at every branch point. Two phases per cycle: notification replies, then value comments. All system prompts and snippet text are externalized into a single `config.js` file so you can edit them without touching code.

---

## 1. The cycle, in plain English

Every cycle does the following, in order:

**Phase A — Reply to notifications**
1. Open the notification bell.
2. For each unread notification that's a reply to one of our comments: literally click it (so it navigates to the post / marks-read on Skool), parse the notification text, and add a record to a candidate list.
3. Send the whole candidate list to an Anthropic LLM (the *notif picker*) with a system prompt + snippet you set in `config.js`. The fixed instruction `"Here are all the notifications of people who have replied to you, choose wich ones to reply to."` is appended automatically.
4. The picker returns a subset (structured output via Anthropic tool-use, so we don't have to parse free-text JSON).
5. For each chosen notification: open the post, scrape the full back-and-forth between the bot and that person in that thread, then call a second Anthropic LLM (the *notif replier*) with another system prompt + snippet you set, plus the fixed `"This is a comment you chose to reply to. Here is the interaction you have had with this person so far [HISTORY]. Reply to them."`
6. Post the reply. Mark the notification as replied-to in the dedup ledger.

**Phase B — Leave value comments**
1. Scrape the last 3 pages of the community feed (configurable).
2. Send the post list to an Anthropic LLM (the *value picker*) with a system prompt you set + the fixed user prompt `"Here is a list of posts. Find posts by people who look like they would be a good fit for scott's program 'I take self-improvement coaches from 0 to 10k in 42 days or they don't pay' to leave value comments under."`
3. For each chosen post: call the *value commenter* LLM with a system prompt + snippet you set, plus the fixed `"Here is a post/comment you chose to reply to, leave a value comment under it using the knowledge above."`
4. Post the comment. Mark the post URL as commented-on in the dedup ledger.

**Loop forever.** Hard guarantee enforced by the dedup ledger: never two replies to the same notification, never two value comments on the same post or comment.

---

## 2. The four LLM calls — a single source of truth

Every prompt in the system lives in **one file** (`bot/agentic/config.js`) so you have one place to edit. Layout:

```
agentic/config.js
├── notif_picker     { system, snippet }   — Phase A pick
├── notif_replier    { system, snippet }   — Phase A write
├── value_picker     { system, snippet }   — Phase B pick
├── value_commenter  { system, snippet }   — Phase B write
└── runtime          { pages_to_scrape, anthropic_model, ... }
```

Each block is two strings: a `system` prompt and a `snippet` that is prepended to the fixed user-message text from your spec. The fixed text is in `notif_phase.js` / `value_phase.js` (so you can't break the spec by accident, but they're also clearly marked if you need to override).

The file ships with `[ EDIT ME — what this prompt is for ]` placeholders in every slot. Nothing is hidden in the source.

---

## 3. File layout

New files (under `bot/agentic/`):
- `config.js` — the prompt + runtime config (the file *you* edit).
- `anthropic_client.js` — thin wrapper around `@anthropic-ai/sdk`. Two functions: `callPicker(...)` returns `{ chosen_ids: [...] }` via forced tool use; `callWriter(...)` returns a plain-text reply.
- `notif_phase.js` — Phase A orchestration.
- `value_phase.js` — Phase B orchestration.
- `dedup.js` — load/save `dedup_ledger.json`; predicates `alreadyRepliedToNotif(id)`, `alreadyCommentedOn(url)`; mutators `markNotifReplied(id, meta)`, `markCommentLeft(url, meta)`.
- `dedup_ledger.json` — the persistence file (auto-created).

Modified files:
- `bot/auto_reply.js` — gutted down to a thin orchestrator: login → `while(true) { runNotifPhase; runValuePhase; }`. The current 519-line implementation moves to `auto_reply_pre_agentic.js` for rollback safety.
- `bot/skool_browser.js` — three new functions added (see §6).
- `bot/package.json` — add `@anthropic-ai/sdk` to dependencies.
- `.env` — add `ANTHROPIC_API_KEY` and (optionally) `ANTHROPIC_MODEL`, `PAGES_TO_SCRAPE`.

Untouched:
- `triage.js`, `generate_reply.js`, `dm_reply.js`, the OpenAI imports — they still exist for the legacy code paths and DM bot. The new agentic loop ignores them.

---

## 4. The dedup ledger (the no-duplicates guarantee)

`dedup_ledger.json` shape:
```json
{
  "notifications": {
    "<href>::<author>::<sha1(snippet)>": {
      "repliedAt": "2026-05-09T12:34:56Z",
      "author": "Jane Doe",
      "snippet": "Jane Doe replied: thanks for the take..."
    }
  },
  "comments_left": {
    "https://www.skool.com/<community>/<post-slug>": {
      "leftAt": "2026-05-09T12:34:56Z",
      "author": "John Smith"
    }
  }
}
```

Notification key = `normalizeHref(href) + "::" + normalizeName(author) + "::" + sha1(first 200 chars of notification text)`. Skool doesn't expose stable notification IDs to the DOM, so this is the most stable composite we can build. If a person replies to multiple of our comments on the same post, the snippet hash distinguishes them.

Comment key = the canonical post URL (or `postURL#commentId` if we extend to commenting on comments later).

Both predicates are checked twice for safety:
1. Before sending the candidate to the picker LLM (so we don't waste tokens on items we already replied to).
2. Right before posting (so a race between cycles can't double-post).

---

## 5. The agentic flow, end to end

```
┌────────────────────────────────────────────────────────────────────────┐
│  CYCLE N                                                               │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  PHASE A — NOTIFICATIONS                                               │
│  ─────────────────────────                                             │
│   1. open bell → list raw items                                        │
│   2. filter to "X replied to..." items                                 │
│   3. drop items already in dedup.notifications                         │
│   4. for each remaining: click → navigate → grab notification text     │
│      ↓                                                                 │
│   5. callPicker({                                                      │
│        system:  config.notif_picker.system,                            │
│        user:    config.notif_picker.snippet                            │
│               + "Here are all the notifications of people who have     │
│                  replied to you, choose wich ones to reply to.\\n\\n"  │
│               + JSON(candidates)                                       │
│      }) → { chosen_ids: [...] }                                        │
│      ↓                                                                 │
│   6. for each chosen notification:                                     │
│        a. navigate to post                                             │
│        b. scrapeThreadHistoryWith(partner, botNames) → [...]           │
│        c. callWriter({                                                 │
│             system: config.notif_replier.system,                       │
│             user:   config.notif_replier.snippet                       │
│                   + "This is a comment you chose to reply to. Here is  │
│                      the interaction you have had with this person     │
│                      so far\\n\\n[HISTORY]\\n\\nReply to them."        │
│           }) → reply text                                              │
│        d. typeCommentReply + submitReply                               │
│        e. dedup.markNotifReplied(id)                                   │
│                                                                        │
│  PHASE B — VALUE COMMENTS                                              │
│  ────────────────────────                                              │
│   1. scrapeFeedNPages(communityUrl, runtime.pages_to_scrape)           │
│   2. drop posts already in dedup.comments_left                         │
│   3. callPicker({                                                      │
│        system: config.value_picker.system,                             │
│        user:   "Here is a list of posts. Find posts by people who      │
│                 look like they would be a good fit for scott's         │
│                 program 'I take self-improvement coaches from 0 to     │
│                 10k in 42 days or they don't pay' to leave value       │
│                 comments under.\\n\\n" + JSON(posts)                   │
│      }) → { chosen_ids: [...] }                                        │
│   4. for each chosen post:                                             │
│        a. openPostAndGetBody                                           │
│        b. callWriter({                                                 │
│             system: config.value_commenter.system,                     │
│             user:   config.value_commenter.snippet                     │
│                   + "Here is a post/comment you chose to reply to,     │
│                      leave a value comment under it using the          │
│                      knowledge above.\\n\\n[POST TEXT]"                │
│           }) → comment text                                            │
│        c. typeReply + submitReply                                      │
│        d. dedup.markCommentLeft(url)                                   │
│                                                                        │
│  loop → CYCLE N+1                                                      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 6. New browser primitives

Three new functions added to `bot/skool_browser.js`:

1. **`clickNotificationItem(page, item)`** — given an item from `getNotificationItems`, find its DOM node and `click()` it. Waits for `domcontentloaded`. Returns the URL we ended up on. Used for step A.4.

2. **`scrapeThreadHistoryWith(page, partnerName, botNames)`** — on a post page, walk the comment tree and return `[{ author, text, ts }, ...]` in chronological order, filtered to comments authored by either the bot (any of `botNames`) or the partner. This is what gets injected into `[HISTORY]` for the notif replier.

3. **`scrapeFeedNPages(page, communityUrl, n)`** — Skool's feed is infinite-scroll; this scrolls the feed container `n` times (~one viewport per "page") with debounced waits, then runs the same `getAllPosts` extraction over the loaded DOM. Default `n=3`.

The existing `typeReply`, `typeCommentReply`, `submitReply`, `openPostAndGetBody`, `clickNotificationBell`, `getNotificationItems`, `markNotificationsRead`, `alreadyCommented`, `login`, `getAllPosts` cover everything else.

---

## 7. Anthropic SDK integration

`bot/agentic/anthropic_client.js`:

```js
const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Picker: forces structured JSON output via tool-use.
async function callPicker({ system, user, model, candidateIds }) {
  const tool = {
    name: "submit_chosen",
    description: "Return the IDs of items you chose.",
    input_schema: {
      type: "object",
      properties: {
        chosen_ids: { type: "array", items: { type: "string", enum: candidateIds } }
      },
      required: ["chosen_ids"]
    }
  };
  const resp = await client.messages.create({
    model, max_tokens: 1024, system,
    tools: [tool], tool_choice: { type: "tool", name: "submit_chosen" },
    messages: [{ role: "user", content: user }]
  });
  // Extract the tool_use block from resp.content
  const toolUse = resp.content.find(b => b.type === "tool_use");
  return toolUse.input; // { chosen_ids: [...] }
}

// Writer: returns the assistant's plain text.
async function callWriter({ system, user, model }) {
  const resp = await client.messages.create({
    model, max_tokens: 400, system,
    messages: [{ role: "user", content: user }]
  });
  return resp.content.map(b => b.type === "text" ? b.text : "").join("").trim();
}
```

Forcing the picker through tool-use means we never have to parse free-text JSON or worry about the model wrapping output in markdown fences.

---

## 8. The orchestrator (the new `auto_reply.js`)

```js
"use strict";
require("dotenv").config();
const { chromium } = require("playwright");
const browser_mod = require("./skool_browser");
const { runNotifPhase } = require("./agentic/notif_phase");
const { runValuePhase } = require("./agentic/value_phase");
const config = require("./agentic/config");

const DRY_RUN  = process.env.DRY_RUN === "true";
const HEADLESS = process.env.HEADLESS === "true";
const COMMUNITY_URL = process.env.SKOOL_COMMUNITY_URL_2 || "https://www.skool.com/hope-nation-7999";

(async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: 50 });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await ctx.newPage();
  const botName = await browser_mod.login(page, process.env.SKOOL_EMAIL, process.env.SKOOL_PASSWORD);

  let cycle = 1;
  while (true) {
    console.log(`\n===== CYCLE ${cycle}${DRY_RUN ? " [DRY RUN]" : ""} =====\n`);

    // Each phase is wrapped in its own try/catch so a failure in Phase A
    // (e.g. picker call timeout, notification scrape error) does NOT prevent
    // Phase B from running — and vice versa. Phase-level errors are logged
    // and the cycle continues; only an unrecoverable error (e.g. browser
    // crash) should kill the loop.
    try {
      await runNotifPhase(page, { botName, config, communityUrl: COMMUNITY_URL, dryRun: DRY_RUN });
    } catch (err) {
      console.error("[Phase A error]", err);
      try { await page.goto("https://www.skool.com", { timeout: 15000 }); } catch (_) {}
    }

    try {
      await runValuePhase(page, { botName, config, communityUrl: COMMUNITY_URL, dryRun: DRY_RUN });
    } catch (err) {
      console.error("[Phase B error]", err);
      try { await page.goto("https://www.skool.com", { timeout: 15000 }); } catch (_) {}
    }

    cycle++;
  }
})();
```

That's the entire orchestrator. All branching intelligence is in `notif_phase.js` and `value_phase.js`, and all written content is in `config.js` + the LLM responses.

**Per-phase isolation matters.** The two `try`/`catch` blocks are deliberate: a Phase A failure (picker LLM timeout, notification scrape selector break, thread history extraction error) must not prevent Phase B from running, and a Phase B failure must not prevent the next cycle's Phase A. Each phase recovers independently by navigating back to `skool.com` so the page is in a sane state for whatever runs next. Only an unrecoverable error (browser crashed, login lost) should propagate up and kill the loop.

---

## 9. The config file you'll edit (sketch)

```js
// bot/agentic/config.js
//
// EDIT THIS FILE to set the four LLM prompts used by the agentic auto-reply
// bot. Each block has a `system` (the model's system prompt) and a `snippet`
// (text prepended to the fixed user instruction your spec defined).
//
// Phase A = Reply to notifications.    Phase B = Leave value comments.

module.exports = {

  // ─── PHASE A ─────────────────────────────────────────────────────────────
  notif_picker: {
    system:  `[ EDIT ME — system prompt for the LLM that picks WHICH notifications to reply to ]`,
    snippet: `[ EDIT ME — extra snippet prepended before the fixed picker instruction ]`,
  },
  notif_replier: {
    system:  `[ EDIT ME — system prompt for the LLM that writes the reply to one chosen notification ]`,
    snippet: `[ EDIT ME — extra snippet prepended before the fixed replier instruction ]`,
  },

  // ─── PHASE B ─────────────────────────────────────────────────────────────
  value_picker: {
    system:  `[ EDIT ME — system prompt for the LLM that picks WHICH posts to leave value comments under ]`,
    snippet: ``, // The fixed picker user prompt already contains the program description.
  },
  value_commenter: {
    system:  `[ EDIT ME — system prompt for the LLM that writes one value comment ]`,
    snippet: `[ EDIT ME — extra snippet prepended before the fixed commenter instruction ]`,
  },

  // ─── RUNTIME ─────────────────────────────────────────────────────────────
  runtime: {
    pages_to_scrape:  parseInt(process.env.PAGES_TO_SCRAPE || "3", 10),
    anthropic_model:  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    max_picks_per_phase: null, // null = no cap; the LLM decides freely
  },
};
```

---

## 10. Implementation order

1. `npm install @anthropic-ai/sdk` in `bot/`, add to `package.json`.
2. Create `bot/agentic/config.js` with all four `[ EDIT ME ]` slots.
3. Create `bot/agentic/anthropic_client.js`.
4. Create `bot/agentic/dedup.js` and seed an empty `dedup_ledger.json`.
5. Add `clickNotificationItem`, `scrapeThreadHistoryWith`, `scrapeFeedNPages` to `skool_browser.js`.
6. Create `bot/agentic/notif_phase.js`.
7. Create `bot/agentic/value_phase.js`.
8. Move current `bot/auto_reply.js` → `bot/auto_reply_pre_agentic.js`. Write the new thin orchestrator.
9. Smoke test with `DRY_RUN=true` against your test community. Check: candidate parsing, picker tool-use response, dedup persistence, no double-replies after a forced re-cycle.
10. Flip `DRY_RUN=false` and let one cycle run live.

---

## 11. Open questions (answer these before I implement)

These are real ambiguities — pick one for each and I'll lock them in.

1. **"Last 3 pages" of the community feed.** Skool feed is infinite-scroll, not paginated. Default plan: scroll the feed container 3 times and take whatever loads (~30–60 posts). Acceptable, or do you want a fixed post count (e.g. "the last 60 posts")?

2. **Value picker scope: posts only, or posts + comments under those posts?** Your picker prompt says `"Here is a list of posts"` but your per-item prompt says `"Here is a post/comment"`. Default plan: posts only in v1; the per-item phrasing accommodates extending to comments later. OK to defer commenting-on-comments?

3. **"Reply notification" filter.** Your spec says "reply to one of our comments." That's strictly text containing `"replied"`. Should I also include `"@-mentioned you"` and `"commented on your post"`? Default: `"replied"` only.

4. **Click-each-notification cost.** Your spec says click each filtered notification before parsing. That's 1 click + navigation + back per item — adds ~5s per notification. With 20 unread that's ~2 minutes before the picker call. Two options:
   - (a) Strict spec: click each one. (Slower but matches what you wrote.)
   - (b) Optimization: collect text from the dropdown without navigating, click only the ones the picker chose. (Same end behavior, ~10x faster.)
   Default: **(a)**, because you said "literally clicking on the notification."

5. **OpenAI dependency.** The existing `triage.js`, `generate_reply.js`, `dm_reply.js` use OpenAI. The new agentic path is Anthropic-only. Keep both SDKs installed (so the legacy code and DM bot still work), or rip OpenAI out entirely? Default: keep both.

6. **Cycle delay.** Current code has a `[TEST] Cycle delay skipped` comment — the delay is currently zero. Want me to put it back (e.g. 30–60 min between cycles), or keep it tight for testing?

---

## 12. Risks I want you to see before I build

- **Thread-history scraping is the single hardest new piece.** Skool comment threads are nested with no obvious `data-author` attribute. We'll have to discover the right class/attribute pattern by inspecting a live thread. If it turns out flaky, the fallback is to feed the model the *full* comment block from the post page and let it reason about who said what — uglier but works.
- **Notification dedup keys are best-effort.** Without a stable Skool notification ID exposed in the DOM, the `(href + author + snippet hash)` key can theoretically collide for two replies from the same person to two of our comments on the same post that happen to start with the same words. Real-world collision risk: very low. Fix if it bites: append a position index from the dropdown.
- **Picker tool-use schema with `enum: candidateIds`.** If you have hundreds of candidates, the JSON schema gets huge and the model occasionally returns IDs not in the enum. Mitigation: cap candidate list size (e.g. top 50 by recency) and validate the response against the original ID set.
- **"Never two value comments under the same post" cuts both ways.** If the bot's previous value comment got buried and the post is back at the top of the feed a week later, dedup will still skip it. That's correct per your spec — calling it out so it's not a surprise.

---

## 13. What's intentionally NOT in this plan

- No author-level cooldown across phases (current bot has 7-day per-author cooldown). You didn't ask for it; the LLM picker can decide if it sees the same author twice in a cycle.
- No "hot leads → DM" handoff (current bot has this). Out of scope for the rework.
- No urgency scores, hook/value taxonomy, or fine-grained intent tags. The picker LLM is the entire decision layer.
- No measurement/feedback loop on whether replies got engagement. Add later if needed.
