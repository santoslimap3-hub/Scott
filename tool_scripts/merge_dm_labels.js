#!/usr/bin/env node
/**
 * merge_dm_labels.js
 *
 * Applies pre-labels from dm_prelabeled.json to all Scott DM events in
 * person_streams.json that don't yet have tags.
 *
 * Priority (highest wins):
 *   1. Scott's manual corrections (scott_dm_corrections.json → new_tags)
 *   2. AI pre-labels (dm_prelabeled.json)
 *   3. Tags already present in person_streams (untouched if no correction)
 *
 * Matching strategy:
 *   - Corrections: exact text match of event.text vs correction.scott_reply
 *     (with whitespace-normalized fallback)
 *   - Pre-labels: first 80 chars of event.text (same key format as prelabel_dms.js)
 *
 * Usage:
 *   node merge_dm_labels.js
 */

const fs   = require('fs');
const path = require('path');

// ── PATHS ──────────────────────────────────────────────────────────────────────
// __dirname is tool_scripts/ — go one level up to the project root
const BASE         = path.join(__dirname, '..');
const STREAMS_PATH = path.join(BASE, 'data/person_streams.json');
const PRELABELED   = path.join(BASE, 'data/fine_tune/dm_prelabeled.json');
const CORRECTIONS  = path.join(BASE, 'data/dms/scott_dm_corrections.json');
const BACKUP_PATH  = path.join(BASE, 'data/person_streams_backup_pre_merge.json');

// ── LOAD ───────────────────────────────────────────────────────────────────────
console.log('Loading person_streams.json …');
const streamsRaw   = fs.readFileSync(STREAMS_PATH, 'utf8');
const streams      = JSON.parse(streamsRaw);

console.log('Loading dm_prelabeled.json …');
const prelabeled   = JSON.parse(fs.readFileSync(PRELABELED, 'utf8'));
const labels       = prelabeled.labels; // keyed by first-80-chars of reply text

console.log('Loading scott_dm_corrections.json …');
const corrections  = JSON.parse(fs.readFileSync(CORRECTIONS, 'utf8'));

// ── BUILD CORRECTIONS LOOKUP ───────────────────────────────────────────────────
// Primary:  exact text match
// Fallback: whitespace-normalised match (handles \r\n vs \n differences)
function normalise(s) {
    return (s || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

const corrByExact    = new Map(); // scott_reply → new_tags
const corrByNorm     = new Map(); // normalised   → new_tags

for (const c of corrections) {
    const reply = c.scott_reply || '';
    corrByExact.set(reply, c.new_tags);
    corrByNorm.set(normalise(reply), c.new_tags);
}

// ── HELPER: derive prelabel key (mirrors prelabel_dms.js line 104) ─────────────
function prelabelKey(text) {
    return (text || '').substring(0, 80).replace(/\s+/g, ' ').trim();
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

// ── MERGE ──────────────────────────────────────────────────────────────────────
let totalScottDms       = 0;
let correctionApplied   = 0;
let prelabelApplied     = 0;
let alreadyTaggedKept   = 0;
let noMatchFound        = 0;

for (const personId of Object.keys(streams.streams)) {
    const events = streams.streams[personId].events || [];

    for (const ev of events) {
        // Only Scott's DM messages
        if (ev.channel !== 'dm' || ev.direction !== 'from_scott') continue;
        totalScottDms++;

        const text     = ev.text || '';
        const normText = normalise(text);

        // ── 1. Manual correction (always wins, even over existing tags) ─────────
        let correction = corrByExact.get(text) ?? corrByNorm.get(normText);
        if (correction) {
            ev.tags = tagsFromLabel(correction, true);
            correctionApplied++;
            continue;
        }

        // ── 2. Already tagged (no correction) → leave untouched ────────────────
        if (ev.tags) {
            alreadyTaggedKept++;
            continue;
        }

        // ── 3. AI pre-label ─────────────────────────────────────────────────────
        const key    = prelabelKey(text);
        const label  = labels[key];
        if (label) {
            ev.tags = tagsFromLabel(label, false);
            prelabelApplied++;
            continue;
        }

        // ── 4. No match ─────────────────────────────────────────────────────────
        noMatchFound++;
    }
}

// ── STATS ──────────────────────────────────────────────────────────────────────
console.log('\n── Results ──────────────────────────────────────────────────────');
console.log(`  Total Scott DM events:          ${totalScottDms}`);
console.log(`  Manual corrections applied:     ${correctionApplied}`);
console.log(`  Already tagged (kept):          ${alreadyTaggedKept}`);
console.log(`  AI pre-labels applied:          ${prelabelApplied}`);
console.log(`  No match found (still unlabeled): ${noMatchFound}`);
console.log(`  Coverage: ${((totalScottDms - noMatchFound) / totalScottDms * 100).toFixed(1)}%`);

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
