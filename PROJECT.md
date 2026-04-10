# OutreachAI - Scott Northwolf AI Clone

## Project Overview

OutreachAI is an AI system that clones the communication style and sales expertise of Scott Northwolf, founder of Self-Improvement Nation and Answer 42. The AI operates under the identity of **Jack Walford** on Skool, acting as an appointment setter who funnels qualified leads into sales calls with Scott.

Scott is a high-level salesman who helps self-improvement coaches go from $0 to $10K/month in 42 days using the "Reverse Engineered $10K Method." His communication style is raw, direct, high-energy "brotherhood" language with no corporate polish. He references philosophy, ancient wisdom, and self-improvement naturally.

### Target Communities
- **Self-Improvement Nation** (primary)
- **Synthesizer** (secondary)

### Bot Account
- Operates under the name **Daniel Carter** (display name on Skool)
- Will eventually operate as **Jack Walford** once the fine-tuned model is production-ready

---

## Architecture

The system has a **Mother AI + Fine-tuned Model** architecture:

```
Mother AI (orchestrator)
  |
  |-- 1. Scrapes posts/comments from Skool communities
  |-- 2. Classifies posts (ICP / advice / other)
  |-- 3. Selects best posts/comments to reply to
  |-- 4. Builds structured prompt with context
  |-- 5. Sends prompt to fine-tuned model
  |-- 6. Posts the response via Playwright browser automation
  |
  v
Fine-tuned Model (trained on Scott's actual interactions)
  |-- Trained on 5,240 examples (v5 JSONL)
  |-- 209 post/comment replies
  |-- 4,810 DM conversations
  |-- 221 first-DM welcome messages
```

### Future Addition: RAG Pipeline
A RAG (Retrieval-Augmented Generation) layer is being built to provide the fine-tuned model with relevant examples of Scott's past interactions as additional context. Currently uses TF-IDF based retrieval with cosine similarity scoring.

---

## Repository Structure

```
OutreachAi/
|
|-- bot/                      # Browser automation bots
|   |-- auto_reply.js         # Main post/comment reply bot (Playwright + OpenAI)
|   |-- dm_reply.js           # DM reply bot (Playwright + OpenAI)
|   |-- replied_posts.json    # Tracks which posts have been replied to
|   |-- replied_dms.json      # Tracks which DMs have been replied to
|   |-- .env                  # SKOOL_EMAIL, SKOOL_PASSWORD, OPENAI_API_KEY
|
|-- rag/                      # RAG pipeline (Anthropic Claude SDK)
|   |-- server.js             # Express server: POST /respond, GET /stats, GET /health
|   |-- respond.js            # Classifies posts + generates responses using Claude
|   |-- retrieval.js          # TF-IDF retrieval engine over Scott's interactions
|   |-- test.js               # Debug test runner with full prompt output
|   |-- .env                  # ANTHROPIC_API_KEY, DATA_PATH, models
|
|-- scraper/                  # Data collection from Skool
|   |-- scraper.js            # Main post scraper (collects posts where Scott replied)
|   |-- scrape_contributions.js # Scrapes Scott's direct contributions
|   |-- dm_scraper.js         # DM scraper (connects to Chrome via CDP)
|   |-- rescrape_see_more.js  # Re-scrapes truncated "See more" post bodies
|   |-- debug.js - debug4.js  # Various debugging scripts
|   |-- output/               # Scraped data output (JSON files)
|   |-- .env                  # Skool credentials
|
|-- tagger/                   # Manual data tagging tool
|   |-- server.js             # Express server serving the tagger UI
|   |-- (reads/writes data/posts_with_scott_reply_threads.json)
|
|-- views/
|   |-- tagger.html           # Web UI for tagging Scott's replies with intent/tone/sales_stage
|
|-- data/                     # Training and scraped data
|   |-- fine_tune/
|   |   |-- finetune_data_v4.jsonl    # Previous training data format
|   |   |-- finetune_data_v5.jsonl    # Current training data (structured prompts)
|   |   |-- scott_finetune.jsonl      # Original fine-tune data
|   |-- posts_with_scott_reply_threads.json          # Main tagged dataset
|   |-- posts_with_scott_reply_threads_backup*.json  # Various backups
|   |-- posts_with_scott_reply.json                  # Posts with Scott's replies (no threads)
|   |-- dm-classified.csv                            # Classified DM data
|
|-- tool_scripts/             # Data processing utilities
|   |-- convert_to_jsonl.rb       # Ruby: converts tagged data to JSONL v1
|   |-- convert_to_jsonl_v2.rb    # Ruby: v2 converter
|   |-- clean_scraped_content.rb  # Ruby: cleans raw scraped HTML
|   |-- merge_contributions.js    # JS: merges contribution data
|   |-- merge_synthesizer.rb      # Ruby: merges Synthesizer community data
|   |-- merge_tags.rb             # Ruby: merges tag data across datasets
|   |-- fix_body_prefix.js        # JS: fixes body text prefix issues
|   |-- fix_synth_posts.js        # JS: fixes Synthesizer post data
|   |-- post_reply_data_extractor.rb    # Ruby: extracts post-reply pairs
|   |-- post_reply_only_filtering.rb    # Ruby: filters to reply-only data
|   |-- data_check_for_scott.rb         # Ruby: validates Scott's data
|   |-- check_synth_posts.js            # JS: validates Synthesizer posts
|   |-- test_jack.rb                    # Ruby: tests Jack persona output
```

---

## Component Details

### bot/auto_reply.js (Main Bot)

The primary automation script. Runs in cycles:

1. **Login** to Skool via Playwright
2. **Scrape all posts** from the community feed (non-pinned only)
3. **Scrape comments** from posts in parallel (2 tabs)
4. **Filter** out already-replied posts/comments
5. **Classify** posts and comments via LLM (ICP / advice / other)
6. **Select** a random subset (3-7 posts, 10-20 comments), prioritizing ICP
7. **Generate replies** using the fine-tuned model (currently OpenAI)
8. **Type and submit** replies via Playwright keyboard automation
9. **Handle notifications** (coin-flip check between items)

The prompt format matches the **v5 JSONL training format** using structured sections:
- `--- POST ---` with Author, Title, and clean body text
- `--- COMMENTS ---` or `--- THREAD ---` with indented reply chains
- `--- REPLY TO ---` isolating the specific message to respond to
- System prompt includes `SITUATION:` tag for mode-switching

### bot/dm_reply.js (DM Bot)

Handles direct message automation with active/inactive periods to simulate human behavior. Connects to Chrome via Playwright, monitors for new DMs, and generates replies.

### rag/ (RAG Pipeline)

Not yet integrated into the main bot. Standalone Express server that:
- Classifies incoming posts by emotional state, type, intent, and sales stage
- Retrieves similar past interactions using TF-IDF + cosine similarity
- Boosts results matching the same intent/sales_stage/category
- Deduplicates results (cosine similarity > 0.7 threshold)
- Generates responses via Claude with retrieved examples as context

### scraper/ (Data Collection)

Two scraper types:
- **Post scraper** (`scraper.js`): Headless Playwright, scrapes community posts with parallel tab processing
- **DM scraper** (`dm_scraper.js`): Connects to user's Chrome via CDP (Chrome DevTools Protocol) on port 9222

### tagger/ (Data Labeling Tool)

Web-based UI for manually tagging Scott's replies with:
- `tone_tags`: hype, brotherhood, motivational, mystery-teasing, casual, humor, etc.
- `intent`: lead-qualification, engagement-nurture, value-delivery, acknowledgement, etc.
- `sales_stage`: awareness, engagement, nurture, close

---

## Fine-Tuning Data

### v5 JSONL Format (Current)

5,240 training examples in OpenAI chat format:

**Post/Comment Replies (209 examples):**
```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are Jack Walford...\nSITUATION: Replying to a Skool post comment.\nSTAGE: nurture\nINTENT: lead-qualification\nTONE: hype, brotherhood"
    },
    {
      "role": "user",
      "content": "--- POST ---\nAuthor: Scott Northwolf\nTitle: We have our very own website now!\n\nI'm really happy to announce...\n\n--- THREAD ---\n[Kai Cerar]: WOW Looks fire BROO!!!!\n  [Scott Northwolf]: @Kai Cerar thanks, brother...\n\n--- REPLY TO ---\n[Kai Cerar]: @Scott Northwolf BROOO LETS FUCKIN GOOOO!!"
    },
    {
      "role": "assistant",
      "content": "@Kai Cerar fire emoji"
    }
  ]
}
```

**First DM (221 examples):**
```json
{
  "role": "user",
  "content": "--- NEW MEMBER ---\nName: Joyce Fortuna\n\nSend a welcome DM."
}
```

**DM Conversations (4,810 examples):**
Multi-turn message arrays with `SITUATION: DM conversation on Skool.` in system prompt. Raw conversation text (no structural markers needed).

### v4 to v5 Changes
- Post/comment replies: Added `--- POST ---`, `--- THREAD ---`, `--- REPLY TO ---` section separators
- First DMs: Added `--- NEW MEMBER ---` structural block
- DM conversations: Unchanged (already well-structured as multi-turn)
- System prompts: Already had `SITUATION:` tags, kept as-is

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Browser automation | Playwright (Chromium) |
| Current LLM (bot) | OpenAI GPT-4o |
| RAG LLM | Anthropic Claude (claude-sonnet) |
| Fine-tuning | OpenAI fine-tuning API |
| Retrieval | Custom TF-IDF + cosine similarity (no vector DB) |
| Tagger UI | Express + static HTML |
| Data processing | Node.js + Ruby scripts |
| Platform | Skool.com |

---

## Environment Variables

### bot/.env
- `SKOOL_EMAIL` - Skool login email
- `SKOOL_PASSWORD` - Skool login password
- `OPENAI_API_KEY` - OpenAI API key for generation
- `OPENAI_MODEL` - Model to use (default: gpt-4o)
- `SKOOL_COMMUNITY_URL_1` - Primary community URL

### rag/.env
- `ANTHROPIC_API_KEY` - Claude API key
- `DATA_PATH` - Path to posts_with_scott_reply_threads.json
- `CLASSIFY_MODEL` - Model for classification (default: claude-sonnet)
- `RESPONSE_MODEL` - Model for generation (default: claude-sonnet)
- `MAX_EXAMPLES` - Number of RAG examples to retrieve (default: 4)
- `PORT` - Server port (default: 3000)

### scraper/.env
- `SKOOL_EMAIL` / `SKOOL_PASSWORD`
- `SKOOL_COMMUNITY_URL`
- `TARGET_MEMBER` - Member to track (default: Scott Northwolf)
- `OUTPUT_FILE` - Output filename

---

## Problem Log

All problems encountered and their solutions are logged here for reference.

### PROBLEM 001: Raw HTML garbage in bot prompts (2025-04-08)

**Symptom:** The `auto_reply.js` bot was sending raw page innerHTML to the LLM as post context. This included emoji picker grids, drag-and-drop instructions ("To pick up a draggable item, press the space bar..."), comment counts, avatar metadata, reaction buttons, and thousands of emoji characters. The model received massive, noisy prompts and generated low-quality replies like "Duty, Honor and Pride." or "There is indeed . . ."

**Root Cause:** The `openPostAndGetBody` function used broad CSS selectors (`[class*="PostContent"]`, `article`, etc.) and extracted `.textContent` from the first match. On Skool's SPA, these containers include all child elements including the comments section, emoji pickers, and interactive UI elements.

**Fix:** Rewrote `openPostAndGetBody` to:
1. Walk through child paragraph nodes specifically, skipping elements with CSS classes matching `emoji|picker|draggable|tooltip|avatar|badge|comment|reply|reaction`
2. Skip any node inside `CommentsSection` / `CommentsList` / `CommentsListWrapper`
3. Filter out UI artifact text (drag-and-drop instructions, "Like", "Reply", emoji category headers)
4. Extract clean post body, author, title, and comment threads as separate structured data
5. Added a new `scrapePostContext` helper function for comment reply scenarios

### PROBLEM 002: Bot prompt structure didn't match fine-tuning JSONL (2025-04-08)

**Symptom:** The fine-tuned model was trained on structured prompts with `--- POST ---`, `--- THREAD ---`, `--- REPLY TO ---` section markers (v5 JSONL format), but the bot was sending flat text like `"Author posted in Category:\n<body>\nWrite a short, natural reply."` The model saw a format it wasn't trained on, leading to poor outputs.

**Root Cause:** The `generateReply` and `generateCommentReply` functions in `auto_reply.js` were written before the v5 JSONL format was designed. They used a simple concatenation format that didn't include structured sections, thread context, or the `SITUATION:` tag in the system prompt.

**Fix:** Rewrote both prompt-building functions:
- `generateReply` (post replies): Now builds `--- POST ---` with Author/Title fields, `--- COMMENTS ---` section with scraped comments, and includes `SITUATION: Replying to a Skool post.` in system prompt
- `generateCommentReply` (comment replies): Now builds `--- POST ---` with full post context, `--- THREAD ---` with indented reply chain, `--- REPLY TO ---` isolating the target message, and includes `SITUATION: Replying to a Skool post comment.` in system prompt
- Added `scrapePostContext` helper to extract clean post data + comment threads when navigating to a comment's post page
- Updated notification handler to use the same v5 format

### PROBLEM 003: v4 JSONL training data had flat/unstructured prompts (2025-04-08)

**Symptom:** The v4 fine-tuning data used flat markers like `[POST by Author] Title\nBody\n[COMMENT by X]: text\n[LATEST from X]: text` with no clear visual separation between post context, thread conversation, and the target message. DM examples had no structural differentiation from post examples beyond the system prompt `SITUATION:` tag.

**Root Cause:** The original JSONL converter didn't apply structured formatting to the user prompts. All post context was concatenated with simple bracket markers.

**Fix:** Created `convert_v4_to_v5.py` script that reformats all 5,240 examples:
- Post/comment replies (209): Added `--- POST ---` / `--- THREAD ---` / `--- REPLY TO ---` sections with Author/Title fields and indented reply chains
- First DMs (221): Reformatted to `--- NEW MEMBER ---` block with Name field
- DM conversations (4,810): Left as-is (multi-turn format was already appropriate)
- Exported as `finetune_data_v5.jsonl` (10.3 MB, 0 validation errors)

### PROBLEM 004: Playwright timeout on community page navigation (2025-04-08)

**Symptom:** `auto_reply.js` consistently timed out with `page.goto: Timeout 30000ms exceeded` when navigating to the Skool community page. Failed on every attempt.

**Root Cause:** The `getAllPosts` function used `waitUntil: "networkidle"` which waits for zero active network connections for 500ms. Skool maintains persistent WebSocket connections, analytics pings, and background API requests that never fully stop, so the "networkidle" condition is never satisfied.

**Fix:** Changed `waitUntil: "networkidle"` to `waitUntil: "domcontentloaded"` in `getAllPosts`, increased timeout to 60s, and added a 4s static delay to ensure the feed has rendered. The `domcontentloaded` event fires once the HTML is parsed, which is sufficient since the post feed is server-rendered.

---

## Modular Classify System (`bot/classify/`)

Built a pre-classification step that runs before every reply is generated. The classifier reads the post/comment context, calls `gpt-4o-mini`, and returns `{ tone_tags, intent, sales_stage, reasoning }`. These tags are then injected into the system prompt sent to the generation model.

### Files

| File | Purpose |
|------|---------|
| `tag_classifier.js` | Main export. Calls gpt-4o-mini, validates output, falls back gracefully. |
| `tags.js` | Single source of truth for all valid tags with Scott-specific definitions. |
| `examples.js` | 13 few-shot examples (one per intent) from real labeled interactions. |

### Usage (in auto_reply.js)
```js
const classifyReply = require("./classify/tag_classifier");
var tags = await classifyReply({ postAuthor, postTitle, postBody, commentAuthor, commentText, thread });
// tags = { tone_tags: ["hype", "brotherhood"], intent: "engagement-nurture", sales_stage: "nurture", reasoning: "..." }
```

### To customize behavior
- **Add/rename tags**: Edit `tags.js`
- **Add/edit examples**: Edit `examples.js` (one example per intent is enough; more is fine)
- **Change the model or temperature**: Edit `tag_classifier.js` — search for `gpt-4o-mini`
- **Change the fallback**: Edit `FALLBACK_TAGS` at the top of `tag_classifier.js`

### PROBLEM 005: tag_classifier.js was a stub — no real LLM call (2025-04-09)

**Symptom:** After building the classify module, `tag_classifier.js` was written as a stub that returned hardcoded defaults without calling the API. The classifier ran but produced the same tags for every post.

**Root Cause:** The file was created with placeholder logic rather than being fully implemented.

**Fix:** Rewrote `tag_classifier.js` to:
1. Import OpenAI, `tags.js`, and `examples.js`
2. Build the full system prompt once at startup (from tag definitions + few-shot examples)
3. Call `gpt-4o-mini` with `response_format: json_object` and `temperature: 0.2`
4. Validate the response against the valid tag lists from `tags.js`
5. Fall back to `FALLBACK_TAGS` on any error

