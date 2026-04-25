// ── Persons Database ────────────────────────────────────────────────────────
// Tracks every person the bot has interacted with and the full history of
// those interactions (post replies, comment replies, DM exchanges).
//
// Structure of persons.json:
// {
//   "_companyMembers": {
//     "Scott Northwolf": "CEO",
//     "Lea Newkirk": "appointment setter"
//   },
//   "Lucas Premat": [
//     { type: "comment",     post_title, author, text, timestamp },
//     { type: "scott_reply", post_title, author, text, timestamp },
//     ...
//   ],
//   "John Smith": [
//     { type: "post",        author, title, body, timestamp },
//     { type: "scott_reply", post_title, author, text, timestamp },
//     ...
//   ]
// }
//
// The "_companyMembers" key is reserved — it is never treated as a person.
// Add or remove company members directly in persons.json, or call setCompanyMember().
//
// Rules enforced by the callers (not this module):
//   - Bot NEVER replies to a second POST by someone already in the DB
//   - Bot CAN reply to comments from known persons (gets logged + sent as context)
//   - DM exchanges are always logged regardless of existing history
//   - When generating a reply for a company member the prompt includes a warning

const fs   = require('fs');
const path = require('path');

const PERSONS_FILE        = path.join(__dirname, '..', 'persons.json');
const COMPANY_MEMBERS_KEY = '_companyMembers';
const GENDERS_KEY         = '_genders';

// ── Name normalization ────────────────────────────────────────────────────────
// Skool renders names in the DOM with non-breaking spaces (\u00a0) instead of
// regular spaces. Normalize before any lookup so "Lea\u00a0Newkirk" matches
// the stored key "Lea Newkirk".
function normalizeName(name) {
    if (!name || typeof name !== 'string') return name;
    return name.replace(/\u00a0/g, ' ').trim();
}

// ── Load ─────────────────────────────────────────────────────────────────────

function loadPersons() {
    try {
        if (fs.existsSync(PERSONS_FILE)) {
            var data = JSON.parse(fs.readFileSync(PERSONS_FILE, 'utf8'));
            // Count only real person entries (not the reserved key)
            var n = Object.keys(data).filter(function(k) { return k !== COMPANY_MEMBERS_KEY; }).length;
            var cm = data[COMPANY_MEMBERS_KEY] ? Object.keys(data[COMPANY_MEMBERS_KEY]).length : 0;
            console.log('📖 [PersonsDB] Loaded — ' + n + ' people tracked, ' + cm + ' company members');
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

// ── Gender cache ──────────────────────────────────────────────────────────────
// Gender is detected once (by LLM or name heuristic) and cached in _genders.
// Callers write it with setPersonGender; read it with getPersonGender.

/**
 * Cache the detected gender for a person.
 * Does nothing if gender is "unknown" and there is already a cached value.
 */
function setPersonGender(persons, name, gender) {
    if (!name || typeof name !== 'string') return;
    if (!gender || gender === 'unknown') return;
    var key = normalizeName(name);
    if (!persons[GENDERS_KEY]) persons[GENDERS_KEY] = {};
    // Don't overwrite a known value with "unknown"
    if (persons[GENDERS_KEY][key] && persons[GENDERS_KEY][key] !== 'unknown') return;
    persons[GENDERS_KEY][key] = gender;
    savePersons(persons);
}

/**
 * Return cached gender for a person, or "unknown" if not yet set.
 */
function getPersonGender(persons, name) {
    if (!name || typeof name !== 'string') return 'unknown';
    var g = persons[GENDERS_KEY];
    if (!g) return 'unknown';
    return g[normalizeName(name)] || 'unknown';
}

// ── Existence check ───────────────────────────────────────────────────────────
// Never returns true for the reserved keys.

function personExists(persons, name) {
    if (!name || typeof name !== 'string') return false;
    var key = normalizeName(name);
    if (key === COMPANY_MEMBERS_KEY || key === GENDERS_KEY) return false;
    return Object.prototype.hasOwnProperty.call(persons, key);
}

// ── Get history ───────────────────────────────────────────────────────────────

function getPersonHistory(persons, name) {
    if (!name || !personExists(persons, name)) return [];
    return persons[normalizeName(name)] || [];
}

// ── Company member helpers ────────────────────────────────────────────────────

/**
 * Check if a person is a known company member.
 */
function isCompanyMember(persons, name) {
    if (!name || typeof name !== 'string') return false;
    var cm = persons[COMPANY_MEMBERS_KEY];
    if (!cm) return false;
    return Object.prototype.hasOwnProperty.call(cm, normalizeName(name));
}

/**
 * Get the company role of a person (e.g. "CEO", "appointment setter").
 * Returns null if not a company member.
 */
function getCompanyRole(persons, name) {
    if (!isCompanyMember(persons, name)) return null;
    return persons[COMPANY_MEMBERS_KEY][normalizeName(name)];
}

/**
 * Mark a person as a company member with a given role.
 * Saves to disk immediately.
 */
function setCompanyMember(persons, name, role) {
    if (!name || typeof name !== 'string') return;
    var key = normalizeName(name);
    if (!persons[COMPANY_MEMBERS_KEY]) persons[COMPANY_MEMBERS_KEY] = {};
    persons[COMPANY_MEMBERS_KEY][key] = role || 'team member';
    savePersons(persons);
    console.log('🏢 [PersonsDB] Company member set: ' + key + ' (' + persons[COMPANY_MEMBERS_KEY][key] + ')');
}

/**
 * Remove a company member flag.
 */
function removeCompanyMember(persons, name) {
    if (!name || typeof name !== 'string') return;
    var cm = persons[COMPANY_MEMBERS_KEY];
    if (!cm) return;
    delete cm[normalizeName(name)];
    savePersons(persons);
}

// ── Add interaction ───────────────────────────────────────────────────────────
// Creates the person entry if it doesn't exist yet.
// Mutates `persons` in place AND saves to disk.

function addInteraction(persons, name, interaction) {
    if (!name || typeof name !== 'string') return;
    var key = normalizeName(name);
    if (key === COMPANY_MEMBERS_KEY || key === GENDERS_KEY) return; // guard: never treat reserved keys as persons

    if (!persons[key]) {
        persons[key] = [];
        if (isCompanyMember(persons, key)) {
            console.log('👤 [PersonsDB] Logging interaction with company member: ' + key + ' (' + getCompanyRole(persons, key) + ')');
        } else {
            console.log('👤 [PersonsDB] NEW person created: ' + key);
        }
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
// If the person is a company member, a clear warning is prepended so the AI
// knows it is NOT talking to a lead.

function formatHistoryForPrompt(history, maxItems, companyRole) {
    var hasHistory = history && history.length > 0;

    // Always emit a block for company members even if no prior interactions
    if (!hasHistory && !companyRole) return '';

    maxItems = maxItems || 8;
    var lines = ['--- PERSON HISTORY ---'];

    // Company member notice — injected before the interaction log
    if (companyRole) {
        lines.push('⚠️  COMPANY MEMBER — Role: ' + companyRole);
        lines.push('This is a member of our own team, NOT a prospect or lead.');
        lines.push('Adjust your reply accordingly (no sales pitch, treat as a colleague).');
    }

    if (hasHistory) {
        lines.push('Previous interactions (oldest first, most recent last):');
        lines.push('');
        var recent = history.slice(-maxItems);
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
                    lines.push('[Bot replied on "' + (h.post_title || 'unknown post').substring(0, 80) + '"]: ' +
                        (h.text || '').substring(0, 200));
                    break;
                case 'dm':
                    if (h.sender === 'person') {
                        lines.push('[Their DM]: ' + (h.text || '').substring(0, 200));
                    } else {
                        lines.push('[Bot DM]: ' + (h.text || '').substring(0, 200));
                    }
                    break;
            }
        }
    }

    return lines.join('\n');
}

// ── Convenience: build prompt block for a person (handles company check) ─────
// This is the main function callers should use instead of calling
// formatHistoryForPrompt directly. Pass the full persons object and the name.

function buildPersonContext(persons, name) {
    var history    = getPersonHistory(persons, name);
    var companyRole = getCompanyRole(persons, name);
    if (!history.length && !companyRole) return '';
    return formatHistoryForPrompt(history, 8, companyRole);
}

module.exports = {
    normalizeName:          normalizeName,
    loadPersons:            loadPersons,
    savePersons:            savePersons,
    personExists:           personExists,
    getPersonHistory:       getPersonHistory,
    isCompanyMember:        isCompanyMember,
    getCompanyRole:         getCompanyRole,
    setCompanyMember:       setCompanyMember,
    removeCompanyMember:    removeCompanyMember,
    addInteraction:         addInteraction,
    formatHistoryForPrompt: formatHistoryForPrompt,
    buildPersonContext:      buildPersonContext,
    setPersonGender:        setPersonGender,
    getPersonGender:        getPersonGender,
};
