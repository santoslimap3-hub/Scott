require 'json'

# Check the output file on disk
output_path = '../../data/fine_tune/finetune_data_v13.jsonl'
total = 0
skool_post = 0
skool_dm = 0
skool_comment = 0

File.foreach(output_path) do |line|
  next if line.strip.empty?
  total += 1
  skool_post    += 1 if line.include?('Skool post.')
  skool_dm      += 1 if line.include?('Skool DM.')
  skool_comment += 1 if line.include?('Skool post comment.')
end

puts "Output file: #{output_path}"
puts "Total lines:           #{total}"
puts "Skool DM examples:     #{skool_dm}"
puts "Skool post comment:    #{skool_comment}"
puts "Skool post (NEW):      #{skool_post}"
puts "File modified:         #{File.mtime(output_path)}"
