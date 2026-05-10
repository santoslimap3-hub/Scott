# What Scott Actually Replies To — Triage Tuning Plan

Source dataset: `scraper/output/all_communities_posts.json` — 718 posts and 4,397 threads, last updated 2026-04-29 (20 pages of Synthesizer = 599 posts, 4 pages of Self-Improvement Nation = 117 posts).

The scraper now captures Scott's actual comments inside the structured `threads` array, so detection no longer needs the `@Scott Northwolf` body-mention proxy. We can ask the cleaner question directly: did Scott write a comment on this post?

(One scraper bug to clean up later: every interaction has `scott_involved: false` regardless of reality. Either fix the detector or drop the field — it currently lies.)

## 1. Headline numbers

Filtering down to *member* posts only (excluding the 44 posts Scott authored himself, which the bot would never reply to anyway):

| Slice | Member posts | Scott replied | Rate |
|---|---|---|---|
| All | 674 | 57 | 8.5% |
| **Self-Improvement Nation** | 75 | 46 | **61.3%** |
| **Synthesizer** | 599 | 11 | **1.8%** |

The community asymmetry is even sharper than the earlier 416-post sample suggested — roughly **34× more likely to engage** in his own community than in Synthesizer. The bot must mirror that.

### Engagement by category

Self-Improvement Nation (engage liberally):

| Category | Engaged / Total | Rate |
|---|---|---|
| General 💭 | 25/34 | 73% |
| Money 💰 | 2/3 | 67% |
| Holistic Self-Improvement 📚 | 7/13 | 54% |
| The Hero's Journey 🗺️ | 8/15 | 53% |
| Mindset 🧠 | 4/9 | 44% |
| Spirituality 👁️ | 0/1 | — |

Synthesizer (essentially silent — every category is sub-5%):

| Category | Engaged / Total | Rate |
|---|---|---|
| 🤑 Monetization | 2/44 | 4.5% |
| 🤝 Networking | 3/128 | 2.3% |
| 🍆 Fun | 1/53 | 1.9% |
| 🎉 Wins | 1/66 | 1.5% |
| 💅 Other | 3/231 | 1.3% |
| 📊 Audience Growth | 1/77 | 1.3% |

Note Monetization being 4.5% even though that's nominally his expertise — earlier analysis on the smaller sample misread this as a hot zone. The bigger sample shows Scott picks his Synthesizer engagements philosophically rather than by category.

### Hard-confirmed skip signals

These rules would correctly drop posts with effectively zero false-skip risk:

| Signal | Engaged / Total | Rate |
|---|---|---|
| Title contains "Day N" | 0/17 | **0%** |
| Title contains "accountability" | 0/24 | **0%** |
| Title is "💥/📈 Synthesizer dai…" | 0/15 | **0%** |
| Category 💅 Other | 3/231 | 1.3% |
| Category 📊 Audience Growth | 1/77 | 1.3% |
| Category 🎉 Wins | 1/66 | 1.5% |
| Category 🍆 Fun | 1/53 | 1.9% |
| Category 🤝 Networking | 3/128 | 2.3% |
| Title is logistics ("community call", "Saturday") | 1/7 | 14% |

The first three are zero false-skips across the dataset. The five categories together cover 555 of the 599 Synthesizer posts (93%) at sub-2.5% engagement rates — they should never reach the LLM classifier.

### Top engaged authors

| Author | Engaged / Their Posts | Notes |
|---|---|---|
| Lea Newkirk | 22/61 | Community manager — top reply target |
| Aeon Bancuyo | 3/4 | Philosophy-leaning member |
| Benjamin S. | 3/3 | 100% reply rate |
| Andreas Leijonmarck | 3/7 | |
| Sajjad Bablu | 2/4 | |
| Laurits Valentin Offersen | 2/9 | |
| Kasparas Stancikas | 2/14 | |

Lea is overwhelmingly the host-author signal. Treating her like a "warm" author (drop floor by 1) would explain a big chunk of Scott's SIN behavior on its own.

### How long are Scott's actual replies?

106 Scott comments captured across member posts. Bimodal length distribution:

| Length bucket | Count | Share |
|---|---|---|
| < 50 chars | 36 | 34% |
| 50–150 chars | 33 | 31% |
| 150–400 chars | 15 | 14% |
| 400+ chars | 22 | 21% |

Median 82 characters, mean 264. About a third of Scott's replies are one-liners (`@Lea Newkirk ALWAYS!`, `facts...`, `I love to see this... keep up the good work, Lea.`). Another third are short paragraphs. The long teaching replies (400+ chars, philosophical / framework-laden) are reserved for substantive sales / niche / identity posts.

This matters for generation as much as triage: the bot is presumably writing too long. Calibrating the generation prompt toward "65% of replies should be ≤150 chars" would mirror Scott's actual behavior, and one-liners are also harder to flub.

### Engagement intensity

When Scott engages, he averages **1.86 comments per post**:

- 1 comment: 32 posts
- 2 comments: 16 posts
- 3 comments: 5 posts
- 5+ comments: 3 posts (max 11 — he gets pulled into back-and-forth threads)

Useful framing: Scott's pattern isn't "comment once and leave" — about a third of the time he comes back to reply to the replies. The bot should leave room for Phase 1 (notification engagement) to handle return visits, which it already does.

## 2. What the existing pipeline already does right

`bot/triage.js` already implements the right shape: an LLM classifier returns `label` (hook / value-flex / ignore) and `flex_score` 0-3, with `applyFlexFloor` dropping anything below 2 (or non-hook). The `BOT_EXPERTISE` block matches Scott's wheelhouse, and `pickDeepTriageCandidates` re-checks edge-case ignores with the full body. The data confirms this is on the right track.

What's missing is calibration against the now-confirmed category-level patterns and a few hard rules the LLM is wasting calls on.

## 3. Specific changes for `bot/triage.js`

### 3.1 Hard skip lists (no LLM call needed)

Add a pre-LLM filter that auto-labels these as `ignore` with `flex_score 0`. On a typical 30-post Synthesizer page this drops ~25 posts before the classifier, cutting LLM cost by roughly 80%.

```js
// triage.js, near top of file
const HARD_SKIP_CATEGORIES = [
    "🍆Fun",                // 1.9% engagement (1/53)
    "🤝Networking",         // 2.3% engagement (3/128)
    "🎉Wins",               // 1.5% engagement (1/66)
    "💅Other",              // 1.3% engagement (3/231)
    "📊Audience Growth",    // 1.3% engagement (1/77)
];

const HARD_SKIP_TITLE_PATTERNS = [
    /\bday\s*\d+\b/i,                              // 0/17 — perfect skip
    /\baccountability\b/i,                         // 0/24 — perfect skip
    /synthesizer\s+dai/i,                          // 0/15 — perfect skip
    /[💥📈]\s*synthesizer/i,                       // catches the emoji-prefixed daily series
    /\bweekly\s+(?:call|community)\b/i,
    /\bsaturday\s+call\b/i,
    /\b(?:replay|workbook|resource\s+drop)\b/i,
];
```

Apply before `triagePosts`:

```js
function preFilterHardSkips(posts) {
    for (var i = 0; i < posts.length; i++) {
        var p = posts[i];
        var cat = (p.category || "").trim();
        var title = (p.title || "");
        if (HARD_SKIP_CATEGORIES.indexOf(cat) !== -1) {
            p.label = "ignore"; p.topic = "off-topic"; p.flex_score = 0;
            p.reason = "hard-skip category " + cat;
            p.preFiltered = true;
            continue;
        }
        for (var j = 0; j < HARD_SKIP_TITLE_PATTERNS.length; j++) {
            if (HARD_SKIP_TITLE_PATTERNS[j].test(title)) {
                p.label = "ignore"; p.topic = "off-topic"; p.flex_score = 0;
                p.reason = "hard-skip title pattern";
                p.preFiltered = true;
                break;
            }
        }
    }
    return posts;
}
```

In `triagePosts`, only send the un-pre-filtered posts to the LLM. The hard-skip categories cover 555 of 599 (93%) of Synthesizer posts at <2.5% engagement — most of these become free skips.

### 3.2 Community-aware flex floor

`CONFIG.flexScoreFloor` is currently a single global. The data says SIN should run looser and Synthesizer tighter:

```js
// auto_reply.js, in CONFIG
flexScoreFloorByCommunity: {
    "self-improvement-nation": 1,   // 61% engagement — be liberal
    "synthesizer":             3,   // 1.8% engagement — be selective
    _default:                  2,
},
```

Resolve the floor at the top of Phase 3 based on the community URL/name, then pass the resolved value to `applyFlexFloor`. This is the single biggest behavioral change — it's what causes the bot to "go quiet" inside outsider communities.

### 3.3 Update the triage prompt with calibrated examples

Replace the hand-written examples in `triage.js`'s `systemPrompt` with examples grounded in the dataset:

```
ENGAGE examples (Scott replied):
  → "What do you do to keep being social?" (SIN / General)
    Genuine member question. Scott replied with a 270-word teaching on
    high-leverage social skills via competence.
    → value-flex flex_score 3
  → "Why are most experts broke?" (Synthesizer / Monetization)
    Concrete claim about expertise→income gap. Bot can riff on positioning.
    → value-flex flex_score 3
  → "Introducing Myself!!" (SIN / Hero's Journey)
    Member intro post. Scott replied "Broooooooooooo, your story gave me the chills."
    → value-flex flex_score 2
  → "Where in the world are you?" (SIN / General, by Lea Newkirk)
    Low-effort host post but worth a touch reply. Bot says where it's based.
    → value-flex flex_score 2

SKIP examples (Scott ignored):
  → "💥Synthesizer daily accountability DAY 31" (Synthesizer / Other)
    Daily accountability series. 0/15 engagement on this pattern.
    → ignore flex_score 0
  → "🔥 Why I Didn't 'Break Up' With Synthesiser Scaling 🔥" (Synth / Wins)
    Pinned launch testimonial. Bot has nothing to add. 1/66 engagement on Wins.
    → ignore flex_score 0
  → "Where are you from?" (Synthesizer / Networking)
    Same shape as Lea's SIN post but in outsider community. Networking
    engagement in Synthesizer is 2.3%.
    → ignore flex_score 0
  → "Weekly community calls ☎️" (SIN / Hero's Journey)
    Logistics announcement. 14% engagement on this pattern.
    → ignore flex_score 0
```

### 3.4 Tighten `DEEP_TRIAGE_IGNORE_HINTS`

Add to the existing list:

```js
const DEEP_TRIAGE_IGNORE_HINTS = [
    "replay", "workbook", "resource drop", "bootcamp", "summit",
    "day 1 replay", "day 2 replay", "day 3 replay",
    // additions confirmed by data:
    "accountability", "synthesizer dai", "weekly call", "saturday call",
    "community call", "strong-end", "happy weekend", "happy friday",
    "level up", "please like", "drop your city", "where are you from",
];
```

### 3.5 Author-allowlist boost

Lea Newkirk got 22/61 engagement — she's the SIN community manager and treating her like a host-author would catch a substantial portion of Scott's actual engagement pattern:

```js
const HOST_AUTHORS_BY_COMMUNITY = {
    "self-improvement-nation": ["Lea Newkirk"],
};
```

In `applyFlexFloor`, if the post author matches the host list for its community, drop the flex floor by 1.

## 4. Where this hooks into `auto_reply.js`

Three integration points, all minimal:

1. **Phase 2 (`runPhase2Triage`, ~line 491)** — call `preFilterHardSkips(allPosts)` before `triagePosts`. Skip the pre-filtered ones so we don't pay for them.
2. **Phase 3 (`runPhase3PublicReplies`, ~line 554)** — replace the `CONFIG.flexScoreFloor` lookup with a per-community resolver. The community is already on `CONFIG.community.name`.
3. **`generate_reply.js`** — no changes needed for triage, but consider tightening the length-target guidance: about two-thirds of Scott's actual replies are ≤150 characters, the bot is likely writing longer than that.

## 5. What this does NOT change

- DM behavior (`dm_sweep`, `pre_classifier`) is for inbound DMs, not feed posts.
- Notification engagements (Phase 1) — when someone @-replies to the bot, we always reply. That mirrors Scott (he averages 1.86 comments per engaged post — return visits are the norm).
- The v5 JSONL prompt format stays the same.

## 6. Verification step (recommended before shipping)

Re-run the same engagement detector on a fresh scrape after the changes are live for ~2 weeks. Targets:

- Synthesizer reply rate: under 5% of posts (Scott's actual: 1.8%).
- Self-Improvement Nation reply rate: 40-65% of member posts (Scott's actual: 61%).
- Reply length: at least 50% of bot replies should be ≤150 characters.

Anything outside those windows means the floor or generation length is mistuned.

## 7. Open questions for Pedro

- The Lea Newkirk allowlist — is she the only one to add, or also Jack Shiller / Aidan LaBreche / others I haven't profiled yet?
- Engagement intensity (1.86 comments per post) is high enough that a single triage pass may double-count: post P passes triage cycle 1, the bot replies, then in cycle 2 the post still passes triage and the bot tries to reply again. The `__threads` ledger handles dedup at the post level, but if the bot wants to mirror "come back to reply to the replies" behavior, it should rely on Phase 1 notifications rather than re-triaging.
- Worth fixing the `scott_involved` field in the scraper or removing it? It's currently false 100% of the time despite Scott replying on 80 posts.
