require 'json'
require 'dotenv'

# Load .env from the scraper directory
Dotenv.load(File.expand_path('../scraper/.env', __dir__))

# Resolve path relative to this script's directory
json_path = File.expand_path('../data/posts_with_scott_reply.json', __dir__)

posts = JSON.parse(File.read(json_path))
count = 0
out_of = 1

posts.each do |post|
  stringthreads = post["threads"].to_s
  if stringthreads.include?("Northwolf")
    count += 1
    puts "Post #{count} of #{out_of}: #{post["id"]}"
  else
    puts "Post #{count} of #{out_of}: #{post["id"]} #{stringthreads}"
  end
  out_of += 1
end

puts ENV['TARGET_MEMBER']