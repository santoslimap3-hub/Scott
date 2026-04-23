// ── Persons Database ────────────────────────────────────────────────────────
// Tracks every person the bot has interacted with and the full history of
// those interactions (post replies, comment replies, DM exchanges).
//
// Structure of persons.json:
// {
//   "John Smith": [
//     { type: "post",        author, title, body, timestamp },
//     { type: "scott_reply", post_title, author, text, timestamp },
//     { type: "comment",     post_title, author, text, timestamp },
//     { type: "scott_reply", post_title, author, text, timestamp },
//     { type: "dm",          author, text, sender: "person|bot", timestamp },
//     ...
//   ]
// }
//
// Rules enforced by the callers (not this module):
//   - Bot NEVER replies to a second POST by someone already in the DB
//   - Bot CAN reply to comments from known persons (gets logged + sent as context)
//   - DM exchanges are always logged regardless of existing history

const fs   = require('fs');
const path = require('path');

const PERSONS_FILE = path.join(__dirname, '..', 'persons.json');

// ── Load ─────────────────────────────────────────────────────────────────────

function loadPersons() {
    try {
        if (fs.existsSync(PERSONS_FILE)) {
            var data = JSON.parse(fs.readFileSync(PERSONS_FILE, 'utf8'));
            var n = Object.keys(data).length;
            console.log('📖 [PersonsDB] Loaded — ' + n + ' people tracked');
            return data;
        }
    } catch (e) {
        console.warn('⚠️  [PersonsDB] Could not load persons.json, starting fresh:', e.message);
    }
    return {};
}

// ── Save (atomic write) ───────────────────────────────────────────────────────

function savePersons(persons) {
    try {
        var tmp = PERSONS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(persons, null, 2));
        fs.renameSync(tmp, PERSONS_FILE);
    } catch (e) {
        console.warn('⚠️  [PersonsDB] Save failed:', e.message);
    }
}

// ── Existence check ───────────────────────────────────────────────────────────

function personExists(persons, name) {
    if (!name || typeof name !== 'string') return false;
    return Object.prototype.hasOwnProperty.call(persons, name.trim());
}

// ── Get history ───────────────────────────────────────────────────────────────

function getPersonHistory(persons, name) {
    if (!name || !personExists(persons, name)) return [];
    return persons[name.trim()];
}

// ── Add interaction ───────────────────────────────────────────────────────────
// Creates the person entry if it doesn't exist yet.
// Mutates `persons` in place AND saves to disk.

function addInteraction(persons, name, interaction) {
    if (!name || typeof name !== 'string') return;
    var key = name.trim();

    if (!persons[key]) {
        persons[key] = [];
        console.log('👤 [PersonsDB] NEW person created: ' + key);
    }

    persons[key].push(interaction);
    savePersons(persons);
    console.log(
        '💾 [PersonsDB] Logged ' + interaction.type +
        ' for "' + key + '"' +
        ' (total interactions: ' + persons[key].length + ')'
    );
}

// ── Format history for prompt injection ──────────────────────────────────────
// Returns a ready-to-inject string block (or '' if no history).
// Only injects the most recent `maxItems` entries to keep token count down.

function formatHistoryForPrompt(history, maxItems) {
    if (!history || history.length === 0) return '';
    maxItems = maxItems || 8;
    var recent = history.slice(-maxItems);

    var lines = ['--- PERSON HISTORY ---'];
    lines.push('Previous interactions with this person (oldest first, most recent last):');
    lines.push('');

    for (var i = 0; i < recent.length; i++) {
        var h = recent[i];
        switch (h.type) {
            case 'post':
                lines.push('[Their post] Title: "' + (h.title || '').substring(0, 120) + '"');
                if (h.body) lines.push('  Body: ' + h.body.substring(0, 200));
                break;
            case 'comment':
                lines.push('[Their comment on "' + (h.post_title || 'unknown post').substring(0, 80) + '"]: ' +
                    (h.text || '').substring(0, 200));
                break;
            case 'scott_reply':
                lines.push('[Scott replied on "' + (h.post_title || 'unknown post').substring(0, 80) + '"]: ' +
                    (h.text || '').substring(0, 200));
                break;
            case 'dm':
                if (h.sender === 'person') {
                    lines.push('[Their DM]: ' + (h.text || '').substring(0, 200));
                } else {
                    lines.push('[Scott DM]: ' + (h.text || '').substring(0, 200));
                }
                break;
        }
    }

    return lines.join('\n');
}

module.exports = {
    loadPersons:            loadPersons,
    savePersons:            savePersons,
    personExists:           personExists,
    getPersonHistory:       getPersonHistory,
    addInteraction:         addInteraction,
    formatHistoryForPrompt: formatHistoryForPrompt,
};
