"""
tool_scripts/autotag_person_streams.py

Auto-tags the 486 untagged post/comment reply events in person_streams.json
using Claude claude-sonnet-4-6, with Scott's own 513 hand-labeled events as few-shot examples.

What it does:
  1. Reads person_streams.json
  2. Finds all untagged events: channel="comment", direction="from_scott", no tags object
  3. Enriches each with post body + thread context from posts_with_scott_reply_threads.json
  4. Pulls 2 examples per intent (26 total) from Scott's 513 labeled events as few-shot context
  5. Calls Claude claude-sonnet-4-6 to classify each event (concurrent batches of 5)
  6. Writes tags back into person_streams.json (with backup created once)
  7. Saves an audit log for spot-check

Resume-safe: re-running will skip already-tagged events.
Progress is saved every 25 events so a crash loses at most 25 events of work.

Usage (from project root):
  python3 tool_scripts/autotag_person_streams.py
  python3 tool_scripts/autotag_person_streams.py --dry-run      (no file writes)
  python3 tool_scripts/autotag_person_streams.py --limit 10     (test first N)

Requires:
  pip install anthropic httpx --break-system-packages
"""

import json
import os
import sys
import time
import shutil
import asyncio
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
import anthropic

# ─── Paths ────────────────────────────────────────────────────────────────────
ROOT              = Path(__file__).resolve().parent.parent
PERSON_STREAMS    = ROOT / "data" / "person_streams.json"
POSTS_FILE        = ROOT / "data" / "posts_with_scott_reply_threads.json"
BACKUP_FILE       = ROOT / "data" / "person_streams_backup_pre_autotag.json"
AUDIT_FILE        = ROOT / "tool_scripts" / "autotag_person_streams_audit.json"
ENV_FILE          = ROOT / "rag" / ".env"

# ─── Config ───────────────────────────────────────────────────────────────────
MODEL             = "claude-haiku-4-5-20251001"   # 100K tokens/min vs 30K for sonnet
TEMPERATURE       = 0.2
CONCURRENCY       = 5     # parallel API calls per batch
EXAMPLES_PER_INTENT = 1   # 13 intents × 1 = 13 few-shot examples (~4K tokens saved)
BATCH_DELAY_SECS  = 8     # seconds to wait between batches to stay under rate limit
MAX_RETRIES       = 3     # retry on rate-limit errors with backoff
SAVE_EVERY        = 25    # write progress to disk every N events

# ─── Valid tags ───────────────────────────────────────────────────────────────
VALID_TONES = [
    "hype", "brotherhood", "motivational", "authority", "direct", "casual",
    "self-aggrandization", "teasing-future-value", "praise", "humor",
    "empathy", "storytelling", "vulnerability", "tough-love", "mystery-teasing",
    "chit-chat", "bonding-rapport", "gratitude", "curiosity",
]
VALID_INTENTS = [
    "acknowledgement", "engagement-nurture", "community-building",
    "authority-proofing", "value-delivery", "close-to-call", "social-proof",
    "redirect", "info-gathering", "lead-qualification", "pain-agitation",
    "objection-handling", "funneling",
]
VALID_STAGES = ["awareness", "engagement", "nurture", "ask"]

FALLBACK = {
    "tone_tags":   ["brotherhood", "motivational"],
    "intent":      "engagement-nurture",
    "sales_stage": "nurture",
    "reasoning":   "fallback — classifier error",
    "confidence":  "low",
}

# ─── Load .env manually ───────────────────────────────────────────────────────
def load_env(path: Path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip("\"'")
            if key and not os.environ.get(key):  # overwrite if missing or empty
                os.environ[key] = val

# ─── JSON helpers ─────────────────────────────────────────────────────────────
def load_json(path: Path):
    raw = path.read_bytes().rstrip(b"\x00").decode("utf-8")
    return json.loads(raw)

def save_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

# ─── Text normalization ───────────────────────────────────────────────────────
def norm(txt: str) -> str:
    """Normalize whitespace + non-breaking spaces for comparison."""
    if not txt:
        return ""
    return " ".join(txt.replace("\u00a0", " ").split())

def is_scott(author: str) -> bool:
    return norm(author or "") == "Scott Northwolf"

def norm_url(url: str) -> str:
    return (url or "").strip().rstrip("/").lower()

# ─── Build post lookup: URL → post entry ──────────────────────────────────────
def build_post_lookup(posts: list) -> dict:
    lookup = {}
    for post in posts:
        url = norm_url((post.get("original_post") or {}).get("url", ""))
        if url:
            lookup[url] = post
    return lookup

# ─── Find thread context for Scott's reply ───────────────────────────────────
def find_thread_context(post_entry: dict, scott_reply_text: str) -> dict | None:
    """
    Returns one of:
      { "type": "root_commenter" }                              — Scott posted the root comment
      { "type": "reply", "root": {...}, "before": [...], "reply_to": {...} }
      None — no match found
    """
    if not post_entry:
        return None

    target = norm(scott_reply_text)[:120].lower()

    for thread in post_entry.get("threads", []):
        comment = thread.get("comment", {})
        replies = thread.get("replies", [])

        # Case 1: Scott is the root commenter
        if is_scott(comment.get("author", "")):
            if norm(comment.get("content", ""))[:120].lower() == target:
                return {"type": "root_commenter"}

        # Case 2: Scott replied within a thread
        for i, reply in enumerate(replies):
            if not is_scott(reply.get("author", "")):
                continue
            if norm(reply.get("content", ""))[:120].lower() == target:
                return {
                    "type":     "reply",
                    "root":     comment,
                    "before":   replies[:i],
                    "reply_to": replies[i - 1] if i > 0 else comment,
                }

    return None

# ─── Format event as v5-style prompt block ────────────────────────────────────
def format_event_prompt(event: dict, post_entry: dict | None) -> str:
    lines = []
    post = (post_entry or {}).get("original_post", {})
    ctx  = find_thread_context(post_entry, event.get("text", "")) if post_entry else None

    # --- POST ---
    lines.append("--- POST ---")
    lines.append(f"Author: {norm(post.get('author', 'Unknown'))}")
    lines.append(f"Title: {event.get('postTitle') or post.get('title') or 'Unknown'}")
    body = post.get("body", "")
    if body:
        body = body[:500] + ("..." if len(body) > 500 else "")
        lines.append("")
        lines.append(body)
    lines.append("")

    if ctx and ctx["type"] == "root_commenter":
        lines.append("--- REPLY TO ---")
        lines.append(f"[Post]: {event.get('postTitle') or 'Community post'}")

    elif ctx and ctx["type"] == "reply":
        lines.append("--- THREAD ---")
        root = ctx["root"]
        lines.append(f"[{root.get('author', 'Member')}]: {root.get('content', '')}")
        for r in ctx["before"]:
            lines.append(f"  [{r.get('author', 'Member')}]: {r.get('content', '')[:200]}")
        lines.append("")
        lines.append("--- REPLY TO ---")
        rt = ctx["reply_to"]
        lines.append(f"[{rt.get('author', 'Member')}]: {rt.get('content', '')[:300]}")

    else:
        # No context found — post title only
        lines.append("--- REPLY TO ---")
        lines.append(f"[Post]: {event.get('postTitle') or 'Community post'}")

    return "\n".join(lines)

# ─── Build few-shot examples from Scott's 513 labeled events ─────────────────
def build_few_shot_examples(data: dict, post_lookup: dict) -> list:
    by_intent = {intent: [] for intent in VALID_INTENTS}

    for pid, stream in data["streams"].items():
        for ev in stream["events"]:
            if ev.get("channel") != "comment":        continue
            if ev.get("direction") != "from_scott":   continue
            if not ev.get("tags"):                     continue
            intent = ev["tags"].get("intent", "")
            if intent not in by_intent:                continue
            if len(by_intent[intent]) >= EXAMPLES_PER_INTENT: continue

            post_entry = post_lookup.get(norm_url(ev.get("postUrl", "")))
            by_intent[intent].append({
                "prompt": format_event_prompt(ev, post_entry),
                "reply":  ev["text"],
                "tags":   ev["tags"],
            })

    examples = []
    for intent in VALID_INTENTS:
        examples.extend(by_intent[intent])
    return examples

# ─── Build classifier system prompt ──────────────────────────────────────────
def build_system_prompt(few_shot: list) -> str:
    example_blocks = []
    for i, ex in enumerate(few_shot, 1):
        tags = ex["tags"]
        block = (
            f"--- EXAMPLE {i} [{tags.get('intent','').upper()}] ---\n"
            f"{ex['prompt']}\n\n"
            f"SCOTT'S REPLY: {ex['reply'][:300]}\n"
            f"TAGS: {json.dumps({'tone_tags': tags.get('tone_tags'), 'intent': tags.get('intent'), 'sales_stage': tags.get('sales_stage')})}\n"
        )
        example_blocks.append(block)

    return "\n".join([
        "You are a classifier for Scott Northwolf's Skool community replies.",
        "Scott is the founder of Self-Improvement Nation and Answer 42.",
        "He helps self-improvement coaches go from $0 to $10K/month in 42 days using the Reverse Engineered $10K Method.",
        "His tone: raw, high-energy brotherhood language, philosophy references, no corporate polish.",
        "",
        "Given: post context + optional thread + Scott's reply.",
        "Task: Output the correct JSON classification.",
        "Key rule: Scott's reply text is the STRONGEST signal. Read it first, then consider context.",
        "",
        "═══ TONE TAGS — pick 1 to 4 ═══",
        "hype                = Maximum energy, ALL CAPS peaks. 'LETS FUCKIN GOOO'. Peak Scott mode.",
        "brotherhood         = Raw male loyalty. 'brother/bro/king'. Street-level, not corporate.",
        "motivational        = Pushing someone forward with conviction and belief.",
        "authority           = Expert certainty. Drops credentials naturally. No arrogance.",
        "direct              = No fluff. Point first. Short punchy sentences.",
        "casual              = Low-key, friend-texting. 'yeah bro', 'lol'. Not trying to impress.",
        "self-aggrandization = References own wins or lifestyle — creates aspiration.",
        "teasing-future-value= Hints at something big coming without revealing it. Creates FOMO.",
        "praise              = Specific genuine recognition of effort or insight.",
        "humor               = Light joke or sarcasm. Never mean.",
        "empathy             = Brief acknowledgement of struggle, then pivots forward.",
        "storytelling        = Short personal anecdote to make a point.",
        "vulnerability       = Briefly reveals a personal challenge — builds trust, rare.",
        "tough-love          = Honest feedback that might sting, said with care.",
        "mystery-teasing     = Creates intrigue around Scott's methods or lifestyle.",
        "chit-chat           = Pure social conversation. No agenda, no value delivery.",
        "bonding-rapport     = Building personal connection through shared references.",
        "gratitude           = Genuine thanks. Rare and real.",
        "curiosity           = Asking because he genuinely wants to know.",
        "",
        "═══ INTENT — pick exactly 1 ═══",
        "acknowledgement    = Short reaction, emoji, 'fire'. No sales agenda. Just being present.",
        "engagement-nurture = Keeps conversation alive and builds warmth. Makes person feel seen.",
        "community-building = Reinforces SIN identity, culture, and belonging.",
        "authority-proofing = Demonstrates expertise passively without being asked.",
        "value-delivery     = Gives a specific actionable insight or framework.",
        "close-to-call      = Invites person to book a call or DM — ONLY with clear buying signal.",
        "social-proof       = Highlights wins or transformations to attract others.",
        "redirect           = Moves conversation toward Scott's offer. Smooth, not abrupt.",
        "info-gathering     = Asks a question to learn about their situation or goals.",
        "lead-qualification = Probes to determine if this person is a coach who could buy.",
        "pain-agitation     = Amplifies someone's problem to make the solution feel urgent.",
        "objection-handling = Addresses a doubt or pushback and flips it into reason to move forward.",
        "funneling          = Directs person toward Scott's community, program, or resources.",
        "",
        "═══ SALES STAGE — pick exactly 1 ═══",
        "awareness  = Person just discovered Scott. Make a good first impression. No selling.",
        "engagement = Person is active but not warm yet. Deepen the relationship.",
        "nurture    = Person is warm and trusts Scott. Stay top of mind, deliver value.",
        "ask        = Person has shown buying signals. Move them toward a call.",
        "",
        "═══ OUTPUT FORMAT ═══",
        "Respond ONLY with valid JSON. No markdown. No text outside the JSON object.",
        '{"tone_tags":["tag1","tag2"],"intent":"one-intent","sales_stage":"one-stage","reasoning":"one sentence","confidence":"high|medium|low"}',
        "",
        "═══ SCOTT'S REAL LABELED EXAMPLES — calibrate against these ═══",
        "",
        "\n".join(example_blocks),
    ])

# ─── Call Claude to classify a single event (with retry on rate limit) ────────
def classify_event(client: anthropic.Anthropic, system_prompt: str, event: dict, post_entry: dict | None) -> dict:
    import re as _re

    context_block = format_event_prompt(event, post_entry)
    user_prompt = (
        f"{context_block}\n\n"
        f"SCOTT'S REPLY: {event.get('text', '')[:500]}\n\n"
        "Classify this reply. Output JSON only."
    )

    for attempt in range(MAX_RETRIES):
        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=200,
                temperature=TEMPERATURE,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
            raw = response.content[0].text.strip()

            # Strip markdown fences if present
            if "```" in raw:
                m = _re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
                if m:
                    raw = m.group(1).strip()

            # Extract JSON object
            m = _re.search(r"\{[\s\S]*\}", raw)
            if m:
                raw = m.group(0)

            parsed = json.loads(raw)

            tone_tags   = [t for t in (parsed.get("tone_tags") or []) if t in VALID_TONES]
            intent      = parsed.get("intent") if parsed.get("intent") in VALID_INTENTS else FALLBACK["intent"]
            sales_stage = parsed.get("sales_stage") if parsed.get("sales_stage") in VALID_STAGES else FALLBACK["sales_stage"]
            reasoning   = str(parsed.get("reasoning") or "")[:250]
            confidence  = parsed.get("confidence") if parsed.get("confidence") in ("high", "medium", "low") else "medium"

            if not tone_tags:
                tone_tags = FALLBACK["tone_tags"]

            return {
                "tone_tags":   tone_tags,
                "intent":      intent,
                "sales_stage": sales_stage,
                "reasoning":   reasoning,
                "confidence":  confidence,
            }

        except anthropic.RateLimitError:
            wait = 20 * (attempt + 1)  # 20s, 40s, 60s
            print(f"\n  ⏳ Rate limit hit — waiting {wait}s before retry {attempt + 1}/{MAX_RETRIES}...")
            time.sleep(wait)
        except Exception as e:
            if attempt < MAX_RETRIES - 1 and ("rate" in str(e).lower() or "429" in str(e)):
                wait = 20 * (attempt + 1)
                print(f"\n  ⏳ Rate limit (429) — waiting {wait}s...")
                time.sleep(wait)
            else:
                return {**FALLBACK, "error": str(e)}

    return {**FALLBACK, "error": "max retries exceeded"}

# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Auto-tag untagged comment events in person_streams.json")
    parser.add_argument("--dry-run", action="store_true", help="Classify but don't write files")
    parser.add_argument("--limit",   type=int,  default=None, help="Only process first N events")
    args = parser.parse_args()

    load_env(ENV_FILE)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("❌  ANTHROPIC_API_KEY not found. Check rag/.env")
        sys.exit(1)

    print("╔══════════════════════════════════════════════╗")
    print("║   OutreachAI — person_streams.json Tagger   ║")
    print("╚══════════════════════════════════════════════╝")
    print(f"🧪  DRY RUN\n" if args.dry_run else f"⚡  LIVE RUN — will write to person_streams.json\n")

    # 1. Load data
    print("📂  Loading data files...")
    data  = load_json(PERSON_STREAMS)
    posts = load_json(POSTS_FILE)
    print(f"    person_streams.json → {data['counts']['totalEvents']} total events")
    print(f"    posts_with_threads  → {len(posts)} posts")

    # 2. Build post lookup
    post_lookup = build_post_lookup(posts)
    print(f"    Post URL index      → {len(post_lookup)} entries\n")

    # 3. Backup (once only — idempotent)
    if not args.dry_run:
        if not BACKUP_FILE.exists():
            print(f"💾  Creating backup → {BACKUP_FILE.name}")
            shutil.copy2(PERSON_STREAMS, BACKUP_FILE)
        else:
            print(f"💾  Backup already exists — skipping (resume mode)")

    # 4. Build few-shot examples
    print("\n📚  Building few-shot examples from Scott's labeled replies...")
    few_shot = build_few_shot_examples(data, post_lookup)
    intent_counts = {}
    for ex in few_shot:
        intent_counts[ex["tags"]["intent"]] = intent_counts.get(ex["tags"]["intent"], 0) + 1
    print(f"    {len(few_shot)} examples across {len(intent_counts)} intents:")
    for intent, count in intent_counts.items():
        print(f"      {intent:<24} × {count}")

    # 5. Build system prompt
    system_prompt = build_system_prompt(few_shot)
    print(f"\n    System prompt: {len(system_prompt):,} chars")

    # 6. Collect untagged events
    print("\n🔍  Collecting untagged comment events from Scott...")
    untagged_queue = []
    for pid, stream in data["streams"].items():
        for idx, ev in enumerate(stream["events"]):
            if (ev.get("channel") == "comment"
                    and ev.get("direction") == "from_scott"
                    and not ev.get("tags")):
                untagged_queue.append({"pid": pid, "idx": idx, "event": ev})

    print(f"    Found {len(untagged_queue)} untagged events")

    if args.limit:
        untagged_queue = untagged_queue[:args.limit]
        print(f"    Limited to first {len(untagged_queue)} (--limit flag)")

    if not untagged_queue:
        print("\n✅  Nothing to tag — all comment events already have tags!")
        return

    # 7. Initialize Anthropic client (SSL verify=False for proxy SSL inspection)
    http_client = httpx.Client(verify=False)
    client = anthropic.Anthropic(api_key=api_key, http_client=http_client)

    # 8. Classify in concurrent batches
    print(f"\n🤖  Classifying with {MODEL} (concurrency={CONCURRENCY})...\n")

    audit_log      = []
    total_tagged   = 0
    total_errors   = 0
    total_processed = 0

    def process_item(item):
        post_entry = post_lookup.get(norm_url(item["event"].get("postUrl", "")))
        return classify_event(client, system_prompt, item["event"], post_entry)

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        # Process in batches — submit batch, collect results, then delay before next batch
        for batch_start in range(0, len(untagged_queue), CONCURRENCY):
            batch          = untagged_queue[batch_start:batch_start + CONCURRENCY]
            future_to_item = {executor.submit(process_item, item): item for item in batch}

            for future in as_completed(future_to_item):
                item  = future_to_item[future]
                total_processed += 1

                try:
                    tags = future.result()
                except Exception as e:
                    tags = {**FALLBACK, "error": str(e)}

                error = tags.pop("error", None)
                flag  = " ❌" if error else (" ⚠️ LOW" if tags["confidence"] == "low" else "")

                print(
                    f"  [{total_processed:>3}/{len(untagged_queue)}] "
                    f"{tags['sales_stage'].upper():<10} | "
                    f"{tags['intent']:<24} | [{', '.join(tags['tone_tags'])}]{flag}"
                )
                if error:
                    print(f"       ERROR: {error}")

                # Apply tags to in-memory data
                if not args.dry_run:
                    data["streams"][item["pid"]]["events"][item["idx"]]["tags"] = {
                        "tone_tags":   tags["tone_tags"],
                        "intent":      tags["intent"],
                        "sales_stage": tags["sales_stage"],
                    }

                audit_log.append({
                    "pid":         item["pid"],
                    "event_idx":   item["idx"],
                    "post_title":  item["event"].get("postTitle", ""),
                    "post_url":    item["event"].get("postUrl", ""),
                    "scott_reply": item["event"].get("text", "")[:300],
                    "auto_tags": {
                        "stage":     tags["sales_stage"],
                        "intent":    tags["intent"],
                        "tone_tags": tags["tone_tags"],
                    },
                    "reasoning":   tags["reasoning"],
                    "confidence":  tags["confidence"],
                    "error":       error,
                    "review_flag": tags["confidence"] != "high" or bool(error),
                })

                if error:
                    total_errors += 1
                else:
                    total_tagged += 1

                # Save progress every SAVE_EVERY events
                if not args.dry_run and total_processed % SAVE_EVERY == 0 and total_processed < len(untagged_queue):
                    save_json(PERSON_STREAMS, data)
                    print(f"  💾  Progress saved ({total_processed}/{len(untagged_queue)})")

            # Delay between batches to stay under token rate limit
            if batch_start + CONCURRENCY < len(untagged_queue):
                time.sleep(BATCH_DELAY_SECS)

    # 9. Final write
    if not args.dry_run:
        print("\n✍️   Writing final person_streams.json...")
        save_json(PERSON_STREAMS, data)
        print("    Done!")

    # 10. Save audit log
    save_json(AUDIT_FILE, audit_log)
    print(f"📋  Audit log saved → {AUDIT_FILE.name}")

    # 11. Summary
    high_count   = sum(1 for e in audit_log if e["confidence"] == "high")
    med_count    = sum(1 for e in audit_log if e["confidence"] == "medium")
    low_count    = sum(1 for e in audit_log if e["confidence"] == "low")
    review_count = sum(1 for e in audit_log if e["review_flag"])

    print("\n══════════════════════════════════════════")
    print("✅  DONE")
    print("══════════════════════════════════════════")
    print(f"  Total processed : {total_processed}")
    print(f"  Tagged OK       : {total_tagged}")
    print(f"  Errors          : {total_errors}")
    print(f"\n  Confidence:")
    print(f"    🟢 High   : {high_count}")
    print(f"    🟡 Medium : {med_count}")
    print(f"    🔴 Low    : {low_count}")
    if review_count > 0:
        print(f"\n  ⚠️  {review_count} events flagged for review")
        print(f"      → Open {AUDIT_FILE.name} and filter review_flag=true")
    if args.dry_run:
        print("\n🧪  DRY RUN — no files modified. Sample output:")
        print(json.dumps(audit_log[:3], indent=2))

if __name__ == "__main__":
    main()
