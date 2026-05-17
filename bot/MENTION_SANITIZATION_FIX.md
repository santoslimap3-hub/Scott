# @Mention Sanitization Fix for Auto-Reply Bot

## Problem
The agentic auto-reply bot was including @mentions (like `@pedro lima`) from reply text and post bodies in prompts sent to the Claude LLM. This caused the model to:
- Misinterpret mentions as instructions to address third parties
- Include those @mentions in its own replies
- Produce confusing responses like "Thanks for the tag, Pedro!" when not appropriate

## Root Cause
Text being sent to LLMs contained @mentions that should have been stripped:
1. **Notification picker**: `reply_text` field included the full text with @mentions
2. **Post/comment picker**: Post bodies and comment text with @mentions were included
3. **RAG context examples**: Historical posts and comments with @mentions were stored
4. **LLM writer prompts**: The target text being replied to included @mentions
5. **RAG queries**: Text used to find similar examples included @mentions

## Solution
Created a centralized text sanitization utility and applied it consistently throughout the workflow:

### 1. New File: `agentic/text_sanitizer.js`
Provides two functions:
- `stripAllMentions(text)`: Removes all @mentions (e.g., "@John Doe" → "")
- `stripMentionsAndChrome(text)`: Also removes notification UI chrome (timestamps, "Like", "Reply" buttons)

Handles:
- Single-word names: `@John`
- Multi-word names: `@John Doe`, `@John M. Doe`
- Names with accents: `@José García`, `@Pedro Lima`
- Leading/trailing whitespace cleanup

### 2. Updated `agentic/notif_phase.js`
Sanitized at every text input point:
- **Step 5 (Picker)**: `reply_text` and `notification` fields in candidate JSON
- **Replier prompt**: History lines and partner's latest message
- **RAG query**: Partner's latest message and prior thread messages

### 3. Updated `agentic/value_phase.js`
Sanitized all text flowing to LLMs:
- **Step 3 (Picker)**: Post `body` field in candidate JSON
- **Commenter prompt**: Full post body before sending to writer
- **RAG query**: Post body used for finding similar examples
- **Comment picker**: Comment `text` field in candidate JSON
- **Comment-reply writer**: Comment text before sending to writer
- **Comment RAG query**: Comment text for finding similar examples

### 4. Updated `agentic/rag_picker.js`
Sanitized the RAG example pool at source:
- Post text and comment text in the `context` field of RAG examples
- This ensures historical examples never contain @mentions

## Impact
✅ **LLM now sees clean text** without @mentions that could confuse it
✅ **Prevents accidental inclusion** of @mentions in bot replies
✅ **Applies consistently** across both notification and value-comment phases
✅ **Handles all mention patterns** including multi-word names and accented characters
✅ **Operates transparently** without affecting dedup logic or other systems

## Testing
The fix applies to:
- Notification replies (Phase A) ✓
- Value comments (Phase B) ✓
- Comment replies under posts ✓
- RAG few-shot examples ✓

All text paths to LLM models now have @mentions stripped before being included in prompts.
