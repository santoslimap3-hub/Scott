SYSTEM_PROMPT = "You are Jack Walford, appointment setter for Answer 42 and Self-Improvement Nation on Skool.\n\nYour mentor and CEO is Scott Northwolf. You funnel qualified leads to book calls with him.\n\nVOICE: Brotherhood energy. Raw, direct, high-energy. Never corporate. Speak like a man who's been through darkness and found the light. You reference philosophy, ancient wisdom and self-improvement naturally because you've lived it. Short punchy sentences. No bullet points, no dashes.\n\nRULES: Never be needy. Never overexplain. Never use dashes or bullet formatting in messages. Create intrigue. You don't need them, they need what you have. Be the sun, not the chaser.\n\nPERSON CONTEXT: Every user prompt begins with a --- PERSON --- block telling you Name, Gender, Role. If Gender is female, use 'sister,' 'queen,' or neutral address — never 'bro,' 'brother,' 'king.' If Role is company-member, this person is ON YOUR TEAM — speak peer to peer, never pitch. If Role is lead, they are a prospect.\n\nMULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting ⟨BUBBLE⟩ between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use ⟨BUBBLE⟩ in post/comment replies — only in DMs."

require 'json'
require 'time'

BUBBLE_THRESHOLD_SECONDS = 300

def time_diff(e1, e2)
  Time.parse(e1["ts"]) - Time.parse(e2["ts"])
rescue
  Float::INFINITY
end

NOT_NAME_WORDS = %w[
  I Yes No True False Well Hey So But And Or It He She We They You
  That This The My Good Great Nice Sure Okay Oh Wow Thanks Thank
  Sorry To In On At By For With From Up Just Even Still Also Never
  Always Maybe Actually Really Very Too More Most Some All Any Each
  Every Both Few Many Much Other Another Same Such Right Wrong High
  Low Open Close Late Far Near After Before While When Where Why
  How What Who Which Write Wrote Got Have Has Been Look Let Me
].freeze

NOT_NAME_PATTERN = /\A@(?:(?!(?:#{NOT_NAME_WORDS.join('|')})\b)[A-Z][^\s,!?]*\s*)+/

def format_event(event, person_name)
  name = event["direction"] == "from_scott" ? "Scott Northwolf" : person_name
  text = event["text"].to_s.strip
  channel = event["channel"]
  post_title = event["postTitle"]

  prefix = case channel
  when "dm"      then "[DM]"
  when "comment" then "[COMMENT on \"#{post_title}\"]"
  when "post"    then "[POST \"#{post_title}\"]"
  else                "[#{channel.upcase}]"
  end

  "#{prefix} #{name}: #{text}"
end

posts_path = File.expand_path('../data/posts_with_scott_reply_threads.json', __dir__)
posts_data = JSON.parse(File.read(posts_path))

# Build lookup: normalized content -> reply object (last in bubble group)
reply_lookup = {}
posts_data.each do |post|
  post["threads"].each do |thread|
    replies = thread["replies"] || []
    i = 0
    while i < replies.length
      reply = replies[i]
      unless reply["author"]&.gsub("\u00a0", " ") == "Scott Northwolf"
        i += 1
        next
      end
      group = [reply]
      while i + 1 < replies.length && replies[i + 1]["author"]&.gsub("\u00a0", " ") == "Scott Northwolf"
        i += 1
        group << replies[i]
      end
      group.each { |r| reply_lookup[r["content"].to_s.strip] = group.last }
      i += 1
    end
  end
end

file_path = File.expand_path('../data/person_streams.json', __dir__)
data = JSON.parse(File.read(file_path))

data["streams"].each do |stream_id, stream|
  person = stream["person"]
  person_name = person["displayName"]
  events = stream["events"]
  puts "\n\n--------#{person_name}--------\n\n"
  i = 0
  while i < events.length
    event = events[i]

    unless event["direction"] == "from_scott" && !event["text"].to_s.strip.empty?
      i += 1
      next
    end

    # Collect all consecutive from_scott messages within threshold as one bubble group
    group = [event]
    while i + 1 < events.length &&
          events[i + 1]["direction"] == "from_scott" &&
          !events[i + 1]["text"].to_s.strip.empty? &&
          time_diff(events[i + 1], events[i]).abs <= BUBBLE_THRESHOLD_SECONDS
      i += 1
      group << events[i]
    end

    prior_events = events[0...(i - group.length + 1)]
    i += 1
    next if prior_events.empty?

    response = group
      .map { |e| e["text"].to_s.strip.gsub(NOT_NAME_PATTERN, "").gsub(/\A[,\s]+/, "") }
      .join("⟨BUBBLE⟩")
    system_prompt = "#{SYSTEM_PROMPT}"
    user_prompt = "--- PERSON --- \nName: #{person_name}\nGender: #{person["gender"]}\nRole: #{person["role"]}"
    user_prompt += "\n------history------\n"
    user_prompt += prior_events[0...-1].map { |e| format_event(e, person_name) }.join("\n")
    user_prompt += "\n------reply to------\n#{format_event(prior_events.last, person_name)}"

    matched_reply = group.map { |e| reply_lookup[e["text"].to_s.strip] }.compact.last
    reply_info = matched_reply ? "\n#{JSON.pretty_generate(matched_reply)}" : ""

    puts "\n\n#{user_prompt}\n\nresponse: #{response}#{reply_info}\n\n"
  end
end
