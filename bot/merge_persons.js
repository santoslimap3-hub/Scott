// merge_persons.js — one-time repair pass on persons.json
//
// Background: before the dm_sweep partner-name fix landed, DM logging used the
// chat-input placeholder as the partner name (e.g. "Lea" from "Message Lea"),
// which created a separate persons.json key from the canonical full-name key
// already used for posts/comments ("Lea Newkirk"). That split the interaction
// history across two records, so the system prompt's PERSON HISTORY block
// only ever saw half the picture.
//
// What this script does:
//   1. Loads persons.json
//   2. Finds single-word person keys whose first word matches exactly ONE
//      multi-word key in the same file. Single-word keys with NO match are
//      left alone (they may be real one-word handles like "Pocket"). Single-
//      word keys with MULTIPLE possible matches are flagged as ambiguous and
//      left alone too — fix those manually if needed.
//   3. Concatenates the source array into the target, dedups by
//      (timestamp + text + type), sorts by timestamp ascending, writes back.
//   4. Drops the now-empty source key.
//   5. Saves a timestamped backup before any mutation.
//
// Usage: from the bot/ directory, run `node merge_persons.js`. Idempotent —
// running a second time after success is a no-op (no merges remain).

var fs = require("fs");
var path = require("path");

var FILE = path.join(__dirname, "persons.json");
var BACKUP = path.join(__dirname, "persons.before-merge-" +
    new Date().toISOString().replace(/[:.]/g, "-") + ".json");

if (!fs.existsSync(FILE)) {
    console.error("persons.json not found at " + FILE);
    process.exit(1);
}

var raw = fs.readFileSync(FILE, "utf8");
var data;
try {
    data = JSON.parse(raw);
} catch (parseErr) {
    console.error("persons.json failed to parse: " + parseErr.message);
    process.exit(1);
}

var RESERVED = ["_companyMembers", "_genders", "_stages"];
var allKeys = Object.keys(data).filter(function(k) { return RESERVED.indexOf(k) === -1; });

// Whitespace/Unicode-tolerant canonicalization. Strips NBSP / narrow NBSP /
// zero-width chars, NFC-normalizes accents, collapses whitespace, lowercases.
// "Lea Newkirk", "Lea Newkirk", "Lea Newkirk " all canonicalize to the
// same value, so near-duplicate keys (the kind that print identically but
// don't === each other) get merged into one canonical entry.
function canonical(name) {
    var s = (name || "").toString();
    try { s = s.normalize("NFC"); } catch (_) {}
    return s
        .replace(/[​-‏⁠﻿]/g, "")     // zero-width chars
        .replace(/[   ]/g, " ")            // NBSP family → space
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

// Codepoint dump for diagnosis — printed when we resolve a near-duplicate.
function codepoints(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
        var cp = s.charCodeAt(i);
        out.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
    }
    return out.join(" ");
}

// Pass 1: collapse near-duplicate top-level keys (same canonical name, but
// different exact bytes). Emits a "near-dup-collapse" merge for each.
var nearDupMerges = [];   // [{ from, to, reason }]
var canonGroups = {};     // canonical → [keys]
allKeys.forEach(function(k) {
    var c = canonical(k);
    if (!canonGroups[c]) canonGroups[c] = [];
    canonGroups[c].push(k);
});
Object.keys(canonGroups).forEach(function(c) {
    var group = canonGroups[c];
    if (group.length < 2) return;
    // Pick the "cleanest" form as the canonical destination: prefer the one
    // whose codepoints match its canonical form exactly (no NBSP, no trailing
    // whitespace), otherwise the longest, otherwise the first alphabetically.
    var dst = group.slice().sort(function(a, b) {
        var aClean = a === a.normalize("NFC").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
        var bClean = b === b.normalize("NFC").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
        if (aClean !== bClean) return aClean ? -1 : 1;
        if (a.length !== b.length) return b.length - a.length;
        return a < b ? -1 : (a > b ? 1 : 0);
    })[0];
    group.forEach(function(k) {
        if (k === dst) return;
        nearDupMerges.push({ from: k, to: dst, reason: "near-duplicate (whitespace/Unicode)" });
    });
});

// Pass 2: same-first-word merges ("Lea" → "Lea Newkirk"). Compute against the
// keys that REMAIN after near-dup collapse so the group sizes are correct.
var remainingKeys = allKeys.filter(function(k) {
    return !nearDupMerges.some(function(m) { return m.from === k; });
});
var byFirst = {};
remainingKeys.forEach(function(k) {
    var first = canonical(k).split(" ")[0];
    if (!byFirst[first]) byFirst[first] = [];
    byFirst[first].push(k);
});

var merges = [];     // [{ from, to, fromCount, toCount, reason }]
var ambiguous = [];  // [{ first, single, multi }]
Object.keys(byFirst).forEach(function(first) {
    var group = byFirst[first];
    if (group.length < 2) return;

    var single = group.filter(function(k) {
        return canonical(k).split(" ").length === 1;
    });
    var multi = group.filter(function(k) {
        return canonical(k).split(" ").length >= 2;
    });

    if (single.length === 0) return;

    if (multi.length === 1) {
        single.forEach(function(s) {
            merges.push({
                from: s,
                to: multi[0],
                fromCount: Array.isArray(data[s]) ? data[s].length : 0,
                toCount:   Array.isArray(data[multi[0]]) ? data[multi[0]].length : 0,
                reason: "first-name-only key",
            });
        });
    } else {
        ambiguous.push({ first: first, single: single, multi: multi });
    }
});

// Combine near-dup pass first, then first-word pass. Order matters because
// the first-word merges target the "kept" key chosen in the near-dup pass.
var allMerges = nearDupMerges.concat(merges);

console.log("=".repeat(60));
console.log("MERGE PLAN");
console.log("=".repeat(60));
console.log("Total person keys: " + allKeys.length);
console.log("Merges queued:     " + merges.length);
console.log("Ambiguous (skipped): " + ambiguous.length);
console.log("");

if (merges.length > 0) {
    console.log("Merges:");
    merges.forEach(function(m) {
        console.log("  " + m.from + " (" + m.fromCount + " entries) → " +
            m.to + " (" + m.toCount + " existing)");
    });
    console.log("");
}
if (ambiguous.length > 0) {
    console.log("Ambiguous (review manually):");
    ambiguous.forEach(function(a) {
        console.log("  '" + a.single.join("', '") + "' could merge into [" +
            a.multi.join(", ") + "] — skipped");
    });
    console.log("");
}

if (merges.length === 0) {
    console.log("Nothing to merge. Exiting.");
    process.exit(0);
}

// Backup before mutating.
fs.writeFileSync(BACKUP, raw);
console.log("Backup saved: " + BACKUP);

function entrySig(entry) {
    return (entry.timestamp || "") + "|" +
           (entry.text || entry.title || "") + "|" +
           (entry.type || "") + "|" +
           (entry.sender || "");
}

merges.forEach(function(m) {
    var src = Array.isArray(data[m.from]) ? data[m.from] : [];
    var dst = Array.isArray(data[m.to])   ? data[m.to]   : [];

    var seen = {};
    var combined = [];
    // Process dst first so that on collision the destination's record wins.
    // (Identical (timestamp, text, type, sender) tuples are de-duped.)
    dst.forEach(function(e) {
        var sig = entrySig(e);
        if (!seen[sig]) { seen[sig] = true; combined.push(e); }
    });
    src.forEach(function(e) {
        var sig = entrySig(e);
        if (!seen[sig]) { seen[sig] = true; combined.push(e); }
    });

    combined.sort(function(a, b) {
        var ta = a.timestamp || "";
        var tb = b.timestamp || "";
        if (ta < tb) return -1;
        if (ta > tb) return 1;
        return 0;
    });

    data[m.to] = combined;
    delete data[m.from];

    console.log("  merged " + m.from + " → " + m.to +
        " (final size: " + combined.length + ")");
});

// Atomic write: stage to .tmp then rename.
var tmp = FILE + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
fs.renameSync(tmp, FILE);

console.log("");
console.log("✅ Wrote " + FILE);
console.log("   " + merges.length + " key(s) merged. Backup at " + BACKUP);
