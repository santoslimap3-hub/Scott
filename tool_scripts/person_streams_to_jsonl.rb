require 'json'
require 'time'

BUBBLE_THRESHOLD_SECONDS = 600  # 10 minutes — tune this if needed
OUTPUT_PATH = File.expand_path('../data/fine_tune/finetune_data_v13.jsonl', __dir__)

file_path = File.expand_path('../data/manual_person_streams.json', __dir__)

BASE_SYSTEM_PROMPT = "You are Jack Walford, appointment setter for Answer 42 and Self-Improvement Nation on Skool.\n\nYour mentor and CEO is Scott Northwolf. You funnel qualified leads to book calls with him.\n\nVOICE: Brotherhood energy. Raw, direct, high-energy. Never corporate. Speak like a man who's been through darkness and found the light. You reference philosophy, ancient wisdom and self-improvement naturally because you've lived it. Short punchy sentences. No bullet points, no dashes.\n\nRULES: Never be needy. Never overexplain. Never use dashes or bullet formatting in messages. Create intrigue. You don't need them, they need what you have. Be the sun, not the chaser.\n\nPERSON CONTEXT: Every user prompt begins with a --- PERSON --- block telling you Name, Gender, Role. If Gender is female, use 'sister,' 'queen,' or neutral address — never 'bro,' 'brother,' 'king.' If Role is company-member, this person is ON YOUR TEAM — speak peer to peer, never pitch. If Role is lead, they are a prospect.\n\nMULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting ⟨BUBBLE⟩ between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use ⟨BUBBLE⟩ in post/comment replies — only in DMs."

def parse_time(str)
  return nil if str.nil? || str.strip.empty?
  Time.strptime(str.strip, "%m/%d/%Y %I:%M:%S %p") rescue nil
end

def scott?(interaction)
  normalized = interaction["author"].to_s.unicode_normalize rescue interaction["author"].to_s
  normalized = normalized.gsub(/\s/, '').downcase.gsub(/[^a-z]/, '')
  normalized == "scottnorthwolf" || normalized == "scott"
end

def display_author(raw_author, person_name)
  raw_author.to_s.strip.downcase == "lead" ? person_name : raw_author
end

def build_system_content(tags, situation_type)
  content = BASE_SYSTEM_PROMPT.dup
  has_tags = tags && !tags.empty?
  if has_tags
    content += "\n\nSTAGE: #{tags['sales_stage']}" if tags['sales_stage']
    content += "\nINTENT: #{tags['intent']}" if tags['intent']
    if tags['tone_tags'] && !tags['tone_tags'].empty?
      content += "\nTONE: #{tags['tone_tags'].join(', ')}"
    end
  end
  situation = situation_type == 'dm' ? 'Skool DM.' : 'Skool post comment.'
  content += "\nSITUATION: Replying to a #{situation}"
  content
end

def build_user_content(person, history)
  lines = []
  lines << "--- PERSON ---"
  lines << "Name: #{person}"
  lines << "Gender: male"
  lines << "Role: lead (prospect)"

  unless history.empty?
    if history.size > 1
      lines << "--- HISTORY ---"
      history[0..-2].each do |h|
        lines << "[#{h[:type].upcase}] #{display_author(h[:author], person)}: #{h[:text]}"
      end
    end
    lines << "--- REPLY TO ---"
    last = history.last
    lines << "[#{last[:type].upcase}] #{display_author(last[:author], person)}: #{last[:text]}"
  end

  lines.join("\n")
end

file_content = File.read(file_path)
data = JSON.parse(file_content)

total_examples = 0
output_lines = []

data.each do |person, info|
  histories = []
  history = []
  i = 0

  while i < info.length
    interaction = info[i]

    if scott?(interaction)
      if history.empty?
        history << {
          type: interaction["type"],
          author: interaction["author"],
          text: interaction["text"]
        }
        i += 1
        next
      end

      # Collect all consecutive Scott messages within the time threshold
      bubble_group = [interaction]
      j = i + 1
      while j < info.length && scott?(info[j])
        prev_time = parse_time(bubble_group.last["datetime"])
        next_time = parse_time(info[j]["datetime"])
        if prev_time && next_time && (next_time - prev_time).abs <= BUBBLE_THRESHOLD_SECONDS
          bubble_group << info[j]
          j += 1
        else
          break
        end
      end

      tags = bubble_group.last["tags"] || {}
      situation_type = history.last[:type]

      system_content = build_system_content(tags, situation_type)
      user_content   = build_user_content(person, history)
      response       = bubble_group.map { |b| b["text"] }.join(" ⟨BUBBLE⟩ ")

      # Debug display extras
      system_prompt_context = BASE_SYSTEM_PROMPT.dup
      unless tags.empty?
        system_prompt_context += "\n\n---TAGS---\n"
        system_prompt_context += "Tone: #{tags['tone_tags'].join(', ')}\n" if tags['tone_tags'] && !tags['tone_tags'].empty?
        system_prompt_context += "Intent: #{tags['intent']}\n" if tags['intent']
        system_prompt_context += "Sales Stage: #{tags['sales_stage']}\n" if tags['sales_stage']
      end

      histories << {
        user_content: user_content,
        system_content: system_content,
        system_prompt_context: system_prompt_context,
        response: response,
        tags: tags,
        bubble_count: bubble_group.size,
        timestamps: bubble_group.map { |b| b["datetime"] },
        jsonl_record: {
          messages: [
            { role: "system",    content: system_content },
            { role: "user",      content: user_content },
            { role: "assistant", content: response }
          ]
        }
      }

      bubble_group.each do |b|
        history << { type: b["type"], author: b["author"], text: b["text"] }
      end

      i = j
    else
      history << {
        type: interaction["type"],
        post_id: interaction["post_id"],
        author: interaction["author"],
        text: interaction["text"]
      }
      i += 1
    end
  end

  next if histories.empty?

  puts "=" * 80
  puts "PERSON: #{person}  (#{histories.size} example#{"s" if histories.size != 1})"
  puts "=" * 80

  histories.each_with_index do |h, idx|
    bubble_label = h[:bubble_count] > 1 ? " - #{h[:bubble_count]} BUBBLES [#{h[:timestamps].join(" | ")}]" : ""
    puts "\n--- Example #{idx + 1}#{bubble_label} ---"
    puts "\n[USER CONTENT]\n#{h[:user_content]}"

    tag_section = h[:tags].empty? ? "(none)" : h[:tags].inspect
    puts "\n[TAGS] #{tag_section}"

    puts "\n[SYSTEM - last 200 chars]\n...#{h[:system_content].chars.last(200).join}"

    puts "\n[RESPONSE#{bubble_label}]\n#{h[:response]}"
    puts
  end

  total_examples += histories.size
  output_lines.concat(histories.map { |h| h[:jsonl_record] })
end

puts "=" * 80
puts "TOTAL EXAMPLES: #{total_examples}"
puts "=" * 80

File.open(OUTPUT_PATH, 'w', encoding: 'utf-8') do |f|
  output_lines.each { |rec| f.puts(JSON.generate(rec)) }
end

puts "\nExported #{output_lines.size} lines -> #{OUTPUT_PATH}"
