require 'json'

def load_json(path)
  content = File.read(path, encoding: 'utf-8')
  # Convert valid surrogate pairs to actual Unicode characters
  content = content.gsub(/\\uD([89ABab][0-9A-Fa-f]{2})\\uD([CDEFcdef][0-9A-Fa-f]{2})/) do
    high = ("D" + $1).to_i(16)
    low  = ("D" + $2).to_i(16)
    [0x10000 + (high - 0xD800) * 0x400 + (low - 0xDC00)].pack("U")
  end
  # Strip any remaining lone surrogates
  content = content.gsub(/\\u[Dd][89AaBbCcDdEeFf][0-9A-Fa-f]{2}/, '')
  JSON.parse(content)
end

# Load person_streams.json
person_streams_path = File.join('..', 'data', 'person_streams.json')
person_streams = load_json(person_streams_path)

# Load data/fine_tune/dm_prelabeled.json
dm_prelabeled_path = File.join('..', 'data', 'fine_tune', 'dm_prelabeled.json')
dm_prelabeled = load_json(dm_prelabeled_path)

# Build lookup keyed by first 80 chars of label text (keys are sometimes truncated)
dm_lookup = {}
dm_prelabeled['labels'].each { |key, label| dm_lookup[key[0, 80]] = label }

matched = 0
unmatched = 0

person_streams['streams'].each do |person_id, stream|
  stream['events'].each do |event|
    next unless event['channel'] == 'dm'

    key = event['text'].to_s[0, 80]
    label = dm_lookup[key]

    if label
      matched += 1
      puts JSON.pretty_generate({
        'person_id' => person_id,
        'text'      => event['text'],
        'ts'        => event['ts'],
        'label'     => label
      })
    else
      unmatched += 1
    end
  end
end

$stderr.puts "Done: #{matched} matched, #{unmatched} unmatched."