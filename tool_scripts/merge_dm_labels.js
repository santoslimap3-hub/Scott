#!/usr/bin/env node
/**
 * tool_scripts/merge_dm_labels.js
 *
 * Applies pre-labels from dm_prelabeled.json to all Scott DM events in
 * person_streams.json that don't yet have tags.
 *
 * Priority (highest wins):
 *   1. Scott's manual corrections  (scott_dm_corrections.json → new_tags)
 *   2. AI pre-labels               (dm_prelabeled.json)
 *   3. Tags already present in person_streams — untouched if no correction
 *
 * Matching strategy for corrections:
 *   Pass 1 — exact text match
 *   Pass 2 — whitespace-normalised match (handles \r\n vs \n)
 *   Pass 3 — strip-markdown match       (handles [url](url) → url)
 *   Pass 4 — 80-char prefix key match   (same key format as prelabel_dms.js)
 *
 * Usage:
 *   node merge_dm_labels.js           # apply labels + save
 *   node merge_dm_labels.js --debug   # show unmatched corrections, dry-run
 */

const fs   = require('fs');
const path = require('path');

const DEBUG = process.argv.includes('--debug');

// ── PATHS ──────────────────────────────────────────────────────────────────────
// __dirname is tool_scripts/ — go one level up to the project root
const BASE         = path.join(__dirname, '..');
const STREAMS_PATH = path.join(BASE, 'data/person_streams.json');
const PRELABELED   = path.join(BASE, 'data/fine_tune/dm_prelabeled.json');
const CORRECTIONS  = path.join(BASE, 'data/dms/scott_dm_corrections.json');
const BACKUP_PATH  = path.join(BASE, 'data/person_streams_backup_pre_merge.json');

// ── LOAD ───────────────────────────────────────────────────────────────────────
console.log('Loading person_streams.json …');
const streamsRaw = fs.readFileSync(STREAMS_PATH, 'utf8');
const streams    = JSON.parse(streamsRaw);

console.log('Loading dm_prelabeled.json …');
let labels = {};
try {
    const prelabeled = JSON.parse(fs.readFileSync(PRELABELED, 'utf8'));
    labels = prelabeled.labels || {};
} catch (e) {
    console.warn(`  ⚠ Could not parse dm_prelabeled.json: ${e.message}`);
    console.warn('  Pre-labels will be skipped. Re-run prelabel_dms.js to regenerate.');
}

console.log('Loading scott_dm_corrections.json …');
const corrections = JSON.parse(fs.readFileSync(CORRECTIONS, 'utf8'));
console.log(`  ${corrections.length} corrections loaded.`);

// ── NORMALISATION HELPERS ──────────────────────────────────────────────────────

// 1. Whitespace normalise: collapse all whitespace (incl. \r\n) to single spaces
function normWS(s) {
    return (s || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

// 2. Strip Markdown links: [display text](url) → url
//    person_streams stores links as [https://...](https://...) but the JSONL/
//    corrections store them as raw https://... URLs.
function stripMarkdown(s) {
    return (s || '')
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$2')  // [text](url) → url
        .replace(/\s+/g, ' ')
        .trim();
}

// 3. 80-char prefix key — same formula as prelabel_dms.js line 104
function prefixKey(s) {
    return (s || '').substring(0, 80).replace(/\s+/g, ' ').trim();
}

// ── BUILD CORRECTIONS LOOKUPS ──────────────────────────────────────────────────
const corrByExact  = new Map(); // raw text              → new_tags
const corrByNorm   = new Map(); // whitespace-normalised → new_tags
const corrByMd     = new Map(); // markdown-stripped     → new_tags
const corrByKey    = new Map(); // 80-char prefix key    → new_tags

for (const c of corrections) {
    const r = c.scott_reply || '';
    corrByExact.set(r,             c.new_tags);
    corrByNorm.set(normWS(r),      c.new_tags);
    corrByMd.set(stripMarkdown(r), c.new_tags);
    // Prefix key — only store the FIRST correction per key to avoid collisions
    const k = prefixKey(r);
    if (!corrByKey.has(k)) corrByKey.set(k, c.new_tags);
}

// ── HELPER: build tags object from a label record ─────────────────────────────
function tagsFromLabel(label, isCorrection) {
    const t = {
        tone_tags:   label.tone_tags   || [],
        intent:      label.intent      || '',
        sales_stage: label.sales_stage || '',
        dm_stage:    label.dm_stage    ?? null,
        nonsales:    label.nonsales    ?? true,
    };
    if (isCorrection) t.manually_corrected = true;
    else              t.ai_suggested       = true;
    return t;
}

// ── LOOKUP: find the best-matching correction for an event text ───────────────
function findCorrection(text) {
    // Pass 1 — exact
    if (corrByExact.has(text))             return { tags: corrByExact.get(text), pass: 1 };
    // Pass 2 — whitespace normalised
    const wn = normWS(text);
    if (corrByNorm.has(wn))                return { tags: corrByNorm.get(wn),  pass: 2 };
    // Pass 3 — markdown stripped
    const md = stripMarkdown(text);
    if (corrByMd.has(md))                  return { tags: corrByMd.get(md),    pass: 3 };
    // Pass 4 — 80-char prefix key
    const k = prefixKey(text);
    if (corrByKey.has(k))                  return { tags: corrByKey.get(k),    pass: 4 };
    return null;
}

// ── MERGE ──────────────────────────────────────────────────────────────────────
let totalScottDms     = 0;
let correctionApplied = 0;
let prelabelApplied   = 0;
let alreadyTaggedKept = 0;
let noMatchFound      = 0;
const passCounts      = { 1: 0, 2: 0, 3: 0, 4: 0 };

for (const personId of Object.keys(streams.streams)) {
    const events = streams.streams[personId].events || [];

    for (const ev of events) {
        if (ev.channel !== 'dm' || ev.direction !== 'from_scott') continue;
        totalScottDms++;

        const text = ev.text || '';

        // ── 1. Manual correction (always wins, even over existing tags) ─────
        const corr = findCorrection(text);
        if (corr) {
            ev.tags = tagsFromLabel(corr.tags, true);
            correctionApplied++;
            passCounts[corr.pass]++;
            continue;
        }

        // ── 2. Already tagged (no correction) → leave untouched ─────────────
        if (ev.tags) {
            alreadyTaggedKept++;
            continue;
        }

        // ── 3. AI pre-label ──────────────────────────────────────────────────
        const key   = prefixKey(text);
        const label = labels[key];
        if (label) {
            ev.tags = tagsFromLabel(label, false);
            prelabelApplied++;
            continue;
        }

        // ── 4. No match ──────────────────────────────────────────────────────
        noMatchFound++;
    }
}

// ── STATS ──────────────────────────────────────────────────────────────────────
console.log('\n── Results ──────────────────────────────────────────────────────');
console.log(`  Total Scott DM events:            ${totalScottDms}`);
console.log(`  Manual corrections applied:       ${correctionApplied}  (pass1=${passCounts[1]} exact, pass2=${passCounts[2]} ws-norm, pass3=${passCounts[3]} md-strip, pass4=${passCounts[4]} prefix-key)`);
console.log(`  Already tagged (kept):            ${alreadyTaggedKept}`);
console.log(`  AI pre-labels applied:            ${prelabelApplied}`);
console.log(`  No match found (still unlabeled): ${noMatchFound}`);
console.log(`  Coverage: ${((totalScottDms - noMatchFound) / totalScottDms * 100).toFixed(1)}%`);

// ── DEBUG MODE: show unmatched corrections ────────────────────────────────────
if (DEBUG) {
    console.log('\n── Unmatched corrections (not found in person_streams) ───────────');

    // Build a set of all DM text variants from person_streams
    const dmExact = new Set();
    const dmNorm  = new Set();
    const dmMd    = new Set();
    const dmKey   = new Set();
    for (const pid of Object.keys(streams.streams)) {
        for (const ev of (streams.streams[pid].events || [])) {
            if (ev.channel !== 'dm' || ev.direction !== 'from_scott') continue;
            const t = ev.text || '';
            dmExact.add(t);
            dmNorm.add(normWS(t));
            dmMd.add(stripMarkdown(t));
            dmKey.add(prefixKey(t));
        }
    }

    let unmatchedCount = 0;
    for (const c of corrections) {
        const r  = c.scott_reply || '';
        const wn = normWS(r);
        const md = stripMarkdown(r);
        const k  = prefixKey(r);

        const matched = dmExact.has(r) || dmNorm.has(wn) || dmMd.has(md) || dmKey.has(k);
        if (!matched) {
            unmatchedCount++;
            console.log(`\n  [${unmatchedCount}] correction_id: ${c.correction_id}`);
            console.log(`      scott_reply (first 120): ${r.substring(0, 120).replace(/\n/g, '↵')}`);
            console.log(`      prefix key: "${k}"`);

            // Find nearest DM event by prefix overlap
            const nearest = [...dmExact].filter(t => {
                const tk = prefixKey(t);
                // Check if they share at least 30 chars
                return k.substring(0, 30) === tk.substring(0, 30);
            });
            if (nearest.length > 0) {
                console.log(`      ⚡ Near match in person_streams: "${prefixKey(nearest[0])}"`);
            }
        }
    }
    if (unmatchedCount === 0) console.log('  All corrections matched ✓');
    console.log(`\n  Total unmatched: ${unmatchedCount} / ${corrections.length}`);
    console.log('\n  (--debug is dry-run: no files were saved)');
    process.exit(0);
}

// ── BACKUP + SAVE ──────────────────────────────────────────────────────────────
if (!fs.existsSync(BACKUP_PATH)) {
    console.log(`\nBacking up original to ${path.basename(BACKUP_PATH)} …`);
    fs.writeFileSync(BACKUP_PATH, streamsRaw);
} else {
    console.log(`\nBackup already exists at ${path.basename(BACKUP_PATH)} — skipping.`);
}

console.log('Saving updated person_streams.json …');
streams.generatedAt = new Date().toISOString();
fs.writeFileSync(STREAMS_PATH, JSON.stringify(streams, null, 2));
console.log('Done ✓');
