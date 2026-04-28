# JSONL Building Pipeline — Session Context

## What This Pipeline Does

Three Ruby scripts that build `finetune_data_v13.jsonl` from raw scraped data:

```
threads_extractor.rb
  → reads:  ../../data/posts_with_scott_reply_threads.json
  → writes: ../../data/scott_threads.json

new_person_streams_builder.rb
  → reads:  ../../data/scott_threads.json
            ../../data/dm_classified.json
  → writes: ../../data/manual_person_streams.json

person_streams_to_jsonl.rb
  → reads:  ../../data/manual_person_streams.json
  → writes: ../../data/fine_tune/finetune_data_v13.jsonl
```

---

## Problem Diagnosed

### There were no clean training examples of Scott making a top-level comment on a post.

The `threads_extractor.rb` script builds thread arrays like:
```
thread[0] = post (type: "post")
thread[1] = top-level commenter
thread[2+] = replies
```

When Scott is `thread[1]` (i.e. he comments directly on a post), the post is included in the person stream. So the `manual_person_streams.json` ends up with 64 messages of `type: "post"`.

However, the old `person_streams_to_jsonl.rb` had **three bugs** for this case:

**Bug 1 — Wrong SITUATION label:**
```ruby
# OLD (broken)
situation = situation_type == 'dm' ? 'Skool DM.' : 'Skool post comment.'
```
There was no branch for `situation_type == 'post'`, so all 63 post-reply examples
were labeled `SITUATION: Replying to a Skool post comment.` instead of `Skool post.`

**Bug 2 — Wrong person context (51 of 63 cases):**
Post-reply examples appeared inside DM leads' streams. The example would say
`Name: Miguel Ariza Lora` but Scott was actually responding to `Bruno Manuel`'s post.

**Bug 3 — Polluted history:**
Because all threads for a person are concatenated into one stream, by the time the
post appeared in history the context had 8–57 unrelated messages from prior threads.

---

## Fix Applied to `person_streams_to_jsonl.rb`

Three additions, minimum code change:

### 1. Added `require 'set'` at top

### 2. Fixed `build_system_content` to handle the `'post'` situation type
```ruby
# NEW
situation = case situation_type
  when 'dm'   then 'Skool DM.'
  when 'post' then 'Skool post.'
  else             'Skool post comment.'
end
```

### 3. Added `post_reply_cases = []` before the main loop

### 4. Skip condition inside the main loop
When `situation_type == 'post'`, instead of generating a broken example, collect it:
```ruby
if situation_type == 'post'
  post_reply_cases << {
    post:         history.last.dup,
    bubble_group: bubble_group,
    tags:         tags
  }
  bubble_group.each do |b|
    history << { type: b["type"], author: b["author"], text: b["text"] }
  end
  i = j
  next
end
```

### 5. Post-reply handler block after the main `data.each` loop
```ruby
seen_post_ids = Set.new
post_reply_cases.each do |prc|
  post_id = prc[:post][:post_id]
  next if post_id && seen_post_ids.include?(post_id)
  seen_post_ids << post_id if post_id

  post         = prc[:post]
  bubble_group = prc[:bubble_group]
  tags         = prc[:tags]
  person_name  = post[:author]
  next if person_name.nil? || person_name.strip.empty?

  system_content = build_system_content(tags, 'post')
  user_content   = build_user_content(person_name, [post])
  response       = bubble_group.map { |b| b["text"] }.join(" ⟨BUBBLE⟩ ")
  ...
end
```

Deduplication by `post_id` is needed because the same post can appear in multiple
DM leads' streams (if multiple leads were in the same thread).

---

## Expected Output After Fix

| Metric | Before | After |
|---|---|---|
| Post-reply examples | 63 (broken, mislabeled) | ~41 (clean, deduplicated) |
| SITUATION label | Always `Skool post comment.` | `Skool post.` ✓ |
| Person context | Wrong (DM lead, not post author) | Correct (post author) ✓ |
| History pollution | Avg 8.9 prior messages | None (just the post) ✓ |

A clean example looks like:
```
SYSTEM: ...SITUATION: Replying to a Skool post.
USER:
--- PERSON ---
Name: Bruno Manuel
Gender: male
Role: lead (prospect)
--- REPLY TO ---
[POST] Bruno Manuel: Respect to the tribe. I'm focused on...
ASSISTANT: Welcome to the gang, Bruno. Glad to have you with us...
```

---

## Debugging Status

The data is confirmed correct:
```
scott_threads.json     — 224/224 threads have type=post as first element ✓
manual_person_streams  — 64 messages with type=post ✓
```

The script code is confirmed correct (syntax OK, logic verified by simulation).

**Pending:** Confirm the output file on disk actually contains `Skool post.` examples
after running the script. Use `debug_types.rb` to check:
```
ruby debug_types.rb
```
Should print `Skool post (NEW): 41` (approximately).

If it prints 0, the issue is likely that the script ran against a stale/different
`manual_person_streams.json` — try re-running `new_person_streams_builder.rb` first,
then `person_streams_to_jsonl.rb`.

---

## Path Notes

All three scripts use `File.expand_path` with `__dir__`. The paths were updated when
the scripts were moved into the `jsonl_building_pipeline/` subfolder:

```ruby
# Correct paths (scripts are in tool_scripts/jsonl_building_pipeline/)
File.expand_path('../../data/...', __dir__)
```

Run all scripts from the `jsonl_building_pipeline/` directory:
```
cd tool_scripts/jsonl_building_pipeline
ruby threads_extractor.rb
ruby new_person_streams_builder.rb
ruby person_streams_to_jsonl.rb
```
