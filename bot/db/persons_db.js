// ── Persons Database (v2 with stage tracking) ──────────────────────────────
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
const STAGES_KEY          = '_stages';

// ── Sales workflow stages (per AUTO_REPLY_V2_UNIFIED_PLAN.md §2) ─────────────
//
//   0 unseen           never replied to or DM'd them
//   1 value-planted    we said something useful in public, no CTA
//   2 publicly-warm    they engaged back / @-mentioned us / DM'd us
//   3 dm-opened        DM thread exists, both sides have spoken
//   4 dm-qualified     classifier confirms answers to "what coach / where stuck"
//   5 call-offered     bot floated call, partner said yes / asked for link
//   6 calendly-sent    link delivered; freeze outbound for 14 days
//
// Per-person stage state is stored under the reserved _stages key:
//   _stages: {
//     "Lucas Premat": {
//       stage: 2,
//       since: 1714291230000,
//       prevStage: 1,
//       reason: "engaged on our reply"
//     }
//   }
const STAGE_MIN = 0;
const STAGE_MAX = 6;
const STAGE_NAMES = [
    'unseen',          // 0
    'value-planted',   // 1
    'publicly-warm',   // 2
    'dm-opened',       // 3
    'dm-qualified',    // 4
    'call-offered',    // 5
    'calendly-sent',   // 6
];

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
    if (key === COMPANY_MEMBERS_KEY || key === GENDERS_KEY || key === STAGES_KEY) return false;
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
    if (key === COMPANY_MEMBERS_KEY || key === GENDERS_KEY || key === STAGES_KEY) return; // guard: never treat reserved keys as persons

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

function formatHistoryForPrompt(history, maxItems, companyRole, options) {
    options = options || {};
    var excludeTypes = Array.isArray(options.excludeTypes) ? options.excludeTypes : [];
    var excludeSet = {};
    for (var ex = 0; ex < excludeTypes.length; ex++) excludeSet[excludeTypes[ex]] = true;

    // Apply type filter BEFORE the maxItems slice so a `dm`-heavy history
    // doesn't crowd out the post/comment items the caller actually wants.
    var filtered = (history || []).filter(function(h) {
        return h && !excludeSet[h.type];
    });
    var hasHistory = filtered.length > 0;

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
        var recent = filtered.slice(-maxItems);
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
//
// options.maxItems     — override the default (8) cap on history entries.
//                        DM-sweep passes a much larger cap (~60) so the full
//                        live conversation fits in the system prompt and the
//                        user prompt can stay bare.
// options.excludeTypes — array of interaction types to drop from the block.

function buildPersonContext(persons, name, options) {
    options = options || {};
    var history    = getPersonHistory(persons, name);
    var companyRole = getCompanyRole(persons, name);
    if (!history.length && !companyRole) return '';
    var cap = (typeof options.maxItems === 'number' && options.maxItems > 0) ? options.maxItems : 8;
    return formatHistoryForPrompt(history, cap, companyRole, options);
}

// ── Stage helpers ─────────────────────────────────────────────────────────────
// Stage is the sales workflow position for a single person (0-6, see top of file).
// Stored under the reserved _stages key. Helpers handle the disk write for you.

function clampStage(stage) {
    var n = parseInt(stage, 10);
    if (isNaN(n)) return STAGE_MIN;
    if (n < STAGE_MIN) return STAGE_MIN;
    if (n > STAGE_MAX) return STAGE_MAX;
    return n;
}

function stageName(stage) {
    var n = clampStage(stage);
    return STAGE_NAMES[n] || ('stage-' + n);
}

function _stagesBucket(persons) {
    if (!persons[STAGES_KEY]) persons[STAGES_KEY] = {};
    return persons[STAGES_KEY];
}

function getStage(persons, name) {
    if (!name || typeof name !== 'string') return 0;
    var key = normalizeName(name);
    if (key === COMPANY_MEMBERS_KEY || key === GENDERS_KEY || key === STAGES_KEY) return 0;
    var bucket = persons[STAGES_KEY] || {};
    var entry = bucket[key];
    if (!entry || typeof entry !== 'object') return 0;
    return clampStage(entry.stage);
}

function getStageEntry(persons, name) {
    if (!name || typeof name !== 'string') return null;
    var key = normalizeName(name);
    var bucket = persons[STAGES_KEY] || {};
    return bucket[key] || null;
}

/**
 * Set a person's stage. Use promote() if you only want to move forward.
 */
function setStage(persons, name, stage, reason) {
    if (!name || typeof name !== 'string') return null;
    var key = normalizeName(name);
    if (key === COMPANY_MEMBERS_KEY || key === GENDERS_KEY || key === STAGES_KEY) return null;

    var bucket = _stagesBucket(persons);
    var prev   = bucket[key] && typeof bucket[key].stage === 'number' ? clampStage(bucket[key].stage) : 0;
    var next   = clampStage(stage);

    bucket[key] = {
        stage:     next,
        prevStage: prev,
        since:     Date.now(),
        reason:    reason || '',
    };
    savePersons(persons);
    console.log('🎯 [PersonsDB] ' + key + ' stage ' + prev + '(' + stageName(prev) + ') → ' + next + '(' + stageName(next) + ')' + (reason ? ' — ' + reason : ''));
    return bucket[key];
}

/**
 * Forward-only stage transition. No-op if the target stage is <= current.
 * Returns the new stage entry, or null if no change happened.
 */
function promote(persons, name, toStage, reason) {
    if (!name || typeof name !== 'string') return null;
    var key = normalizeName(name);
    if (key === COMPANY_MEMBERS_KEY || key === GENDERS_KEY || key === STAGES_KEY) return null;

    var current = getStage(persons, name);
    var target  = clampStage(toStage);
    if (target <= current) return null;
    return setStage(persons, name, target, reason);
}

/**
 * Persons newly promoted to a given stage in the last `windowMs` milliseconds.
 * Used by Phase 4 (outbound DM opens) to find people that hit stage 2 since
 * the last cycle ran.
 */
function listPromotedTo(persons, stage, windowMs) {
    var target = clampStage(stage);
    var cutoff = Date.now() - (windowMs || 24 * 60 * 60 * 1000);
    var bucket = persons[STAGES_KEY] || {};
    var out = [];
    Object.keys(bucket).forEach(function(name) {
        var entry = bucket[name];
        if (!entry || typeof entry !== 'object') return;
        if (clampStage(entry.stage) !== target) return;
        if (typeof entry.since !== 'number' || entry.since < cutoff) return;
        out.push({ name: name, entry: entry });
    });
    out.sort(function(a, b) { return b.entry.since - a.entry.since; });
    return out;
}

/**
 * Backfill stages for everyone in the persons DB by inferring from their
 * interaction history. Idempotent — only writes when a higher stage is
 * inferred than what's currently stored. Safe to run on every boot.
 *
 * Heuristic (mirrors §2 stage transitions):
 *   - any DM exchange where bot floated a calendly link → stage 6
 *   - any DM where bot offered a call                   → stage 5
 *   - any DM exchange (both sides spoke)                → stage 3
 *   - any of: their reply to our public reply, scott_reply followed by them
 *             posting again                             → stage 2
 *   - bot has commented on them                         → stage 1
 *   - otherwise                                         → 0
 */
function backfillStages(persons) {
    var changed = 0;
    var keys = Object.keys(persons || {});
    keys.forEach(function(name) {
        if (name === COMPANY_MEMBERS_KEY || name === GENDERS_KEY || name === STAGES_KEY) return;
        var history = persons[name];
        if (!Array.isArray(history) || history.length === 0) return;

        var inferred = inferStageFromHistory(history);
        if (inferred <= 0) return;

        var current = getStage(persons, name);
        if (inferred > current) {
            setStage(persons, name, inferred, 'backfilled from history');
            changed++;
        }
    });
    if (changed > 0) {
        console.log('🧮 [PersonsDB] Backfilled stage for ' + changed + ' person(s)');
    }
    return changed;
}

function inferStageFromHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return 0;

    // Walk the history once and collect signals.
    var signals = {
        botCommented:      false,
        partnerEngagedBack: false,
        dmBothSides:       false,
        botFloatedCall:    false,
        botSentCalendly:   false,
    };
    var sawScottReply  = false;
    var sawBotDm       = false;
    var sawPartnerDm   = false;

    for (var i = 0; i < history.length; i++) {
        var h = history[i] || {};
        var type = h.type;
        var text = String(h.text || '').toLowerCase();

        if (type === 'scott_reply') {
            signals.botCommented = true;
            sawScottReply = true;
        }

        // A 'comment' from the partner that comes after we replied counts as
        // engagement back on our reply.
        if (type === 'comment' && sawScottReply) {
            signals.partnerEngagedBack = true;
        }

        if (type === 'dm') {
            if (h.sender === 'bot') sawBotDm = true;
            else if (h.sender === 'person') sawPartnerDm = true;
            if (sawBotDm && sawPartnerDm) signals.dmBothSides = true;

            if (h.sender === 'bot') {
                if (/calendly\.com|calendly|book(\s|ed)?\s+(a|the)\s+call|here'?s\s+my\s+link/.test(text)) {
                    signals.botSentCalendly = true;
                }
                if (/jump\s+on\s+a\s+(quick\s+)?call|hop\s+on\s+a\s+call|set\s+up\s+a\s+call|schedule\s+a\s+call/.test(text)) {
                    signals.botFloatedCall = true;
                }
            }
        }
    }

    if (signals.botSentCalendly)   return 6;
    if (signals.botFloatedCall)    return 5;
    if (signals.dmBothSides)       return 3;
    if (signals.partnerEngagedBack) return 2;
    if (signals.botCommented)      return 1;
    return 0;
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

    // ── Stage helpers ──
    STAGE_MIN:        STAGE_MIN,
    STAGE_MAX:        STAGE_MAX,
    STAGE_NAMES:      STAGE_NAMES,
    getStage:         getStage,
    getStageEntry:    getStageEntry,
    setStage:         setStage,
    promote:          promote,
    stageName:        stageName,
    listPromotedTo:   listPromotedTo,
    backfillStages:   backfillStages,
};
