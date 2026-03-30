require 'json'
require 'dotenv'

# Load .env from the scraper directory
Dotenv.load(File.expand_path('../scraper/.env', __dir__))


# Resolve path relative to this script's directory
json_path = File.expand_path('../scraper/output/skool_data.json', __dir__)

data = JSON.parse(File.read(json_path))

scott_replies = []

posts = data["interactions"]
posts.each do |post|
  scott_involved = post["threads"]&.any? do |thread|
    thread.dig("comment", "author")&.include?("Northwolf") ||
      (thread["replies"] || []).any? { |r| r["author"]&.include?("Northwolf") }
  end
  scott_replies << post if scott_involved
end

## NOW FOR SYNTHESIZER ##

json_path = File.expand_path('../scraper/output/synthesizer_data.json', __dir__)

data = JSON.parse(File.read(json_path))

posts = data["interactions"]
posts.each do |post|
  scott_involved = post["threads"]&.any? do |thread|
    thread.dig("comment", "author")&.include?("Northwolf") ||
      (thread["replies"] || []).any? { |r| r["author"]&.include?("Northwolf") }
  end
  scott_replies << post if scott_involved
end

## WRITE COMBINED RESULTS ##

output_path = File.expand_path('../data/posts_with_scott_reply.json', __dir__)
File.write(output_path, JSON.pretty_generate(scott_replies))
puts "Wrote #{scott_replies.length} posts to #{output_path}"


