require 'json'

def clean_text(str)
  str.to_s.lstrip.sub(/\A@\S+\s+\S+\s*/, '')
end

dm_json_path = File.expand_path('../data/dm_classified.json', __dir__)
thread_json_path = File.expand_path('../data/scott_threads.json', __dir__)
data_threads = JSON.parse(File.read(thread_json_path))
data_dm = JSON.parse(File.read(dm_json_path))
person = nil
people = {}
persons = []
data_dm.each do |row|
  if row["Contact"] == person
    people[person] << {
      type: "dm",
      datetime: "#{row["Date"]} #{row["Time"]}",
      person: row["Contact"],
      author: row["Speaker"],
      text: clean_text(row["Message"]),
      tags: row["Tags"] || {}
    }
  else
    person = row["Contact"]
    persons << person.gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, '') unless persons.include?(person.gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, ''))
    people[person] = []
    data_threads.each do |thread|
      if thread[0]["authors"].include?(row["Contact"].gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, ''))
        if thread[1]["author"].gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, '') == "scottnorthwolf"
          thread.each do |message|
            people[person] << {
              type: message["type"] || "comment",
              post_id: message["post_id"],
              author: message["author"],
              text: clean_text(message["text"]),
              tags: message["tags"] || {}
          }
          end
        else
          thread.each_with_index do |message, idx|
            next if idx == 0
            people[person] << {
              type: message["type"] || "comment",
              post_id: message["post_id"],
              author: message["author"],
              text: clean_text(message["text"]),
              tags: message["tags"] || {}
            }
          end
        end
      end
    end
    people[person] << {
      type: "dm",
      datetime: "#{row["Date"]} #{row["Time"]}",
      person: row["Contact"],
      author: row["Speaker"],
      text: clean_text(row["Message"]),
      tags: row["Tags"] || {}
      }
  end
end

data_threads.each do |thread|
  authors = []

  thread[0]["authors"].each do |author|
      authors << author.gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, '')
  end

  if authors.none? { |author| persons.include?(author) }
    if thread[1]["author"].gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, '') == "scottnorthwolf"
      people[thread[0]["author"]] = [{
        type: thread[0]["type"] || "comment",
        post_id: thread[0]["post_id"],
        author: thread[0]["author"],
        text: clean_text(thread[0]["text"]),
      }]
      thread.each_with_index do |message, idx|
        next if idx == 0
        people[thread[0]["author"]] << {
          type: message["type"] || "comment",
          post_id: message["post_id"],
          author: message["author"],
          text: clean_text(message["text"]),
          tags: message["tags"] || {}
        }
      end
    else
      people[thread[0]["author"]] = [{
        type: thread[0]["type"] || "comment",
        post_id: thread[0]["post_id"],
        author: thread[0]["author"],
        text: clean_text(thread[0]["text"]),
        tags: thread[0]["tags"] || {}
      }]
      thread.each_with_index do |message, idx|
        next if idx == 0
        people[thread[0]["author"]] << {
          type: message["type"] || "comment",
          post_id: message["post_id"],
          author: message["author"],
          text: clean_text(message["text"]),
          tags: message["tags"] || {}
        }
      end
    end
  end
end
output_path = File.expand_path('../data/manual_person_streams.json', __dir__)
File.write(output_path, JSON.pretty_generate(people))
