require 'json'

threads = []
file_path = File.expand_path('../data/posts_with_scott_reply_threads.json', __dir__)
data = JSON.parse(File.read(file_path))

data.each do |post|
  post_id = post["id"]
  post["threads"].each do |thread_data|
    thread = []
    post_author_key = post["original_post"]["author"].gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, '')
    comment_author_key = thread_data["comment"]["author"].gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, '')
    authors = [post_author_key, comment_author_key].uniq
    puts JSON.pretty_generate(thread_data)
    thread << {
      type: "post",
      post_id: post_id,
      author: post["original_post"]["author"],
      title: post["original_post"]["title"],
      text: post["original_post"]["body"].split("\nLike\n")[0].split(post["original_post"]["title"])[1]&.strip || post["original_post"]["body"].split("\nLike\n")[0].strip
    }
    thread << {
      type: "comment",
      post_id: post_id,
      author: thread_data["comment"]["author"],
      text: thread_data["comment"]["content"],
    }
    thread_data["replies"].each do |reply|
      authors << reply["author"].gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, '') unless authors.include?(reply["author"].gsub(/\s|\u00A0/, '').downcase.gsub(/[^\w]/, ''))
      thread << {
        post_id: post_id,
        author: reply["author"],
        text: reply["content"],
        tags: reply["tags"] || [],
      }
    end
    thread[0][:authors] = authors
    if thread[0][:authors].include?("scottnorthwolf")
      threads << thread
    end
  end
end

output_path = File.expand_path('../data/scott_threads.json', __dir__)
File.write(output_path, JSON.pretty_generate(threads))