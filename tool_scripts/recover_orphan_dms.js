#!/usr/bin/env node
/**
 * tool_scripts/recover_orphan_dms.js
 *
 * Finds DM conversations in finetune_data_v5.jsonl whose messages are
 * completely absent from dm-classified.csv, then injects them into
 * person_streams.json as recovered events so no training data is lost.
 *
 * Background
 * ----------
 * The JSONL was generated from an older version of dm-classified.csv.
 * The CSV was regenerated at some point and lost historical conversation data.
 * The JSONL is the only surviving source for those conversations.
 *
 * Each recovered conversation gets its own stream with ID "recovered:{index}"
 * and the best name we can extract from Scott's replies (he often addresses
 * people by first name).  A human can clean up the names later.
 *
 * Usage
 *   node recover_orphan_dms.js          # detect + inject + save
 *   node recover_orphan_dms.js --dry    # detect only, print report, no save
 */

const fs   = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');

const ROOT    = path.join(__dirname, '..');
const JSONL   = path.join(ROOT, 'data/fine_tune/finetune_data_v5.jsonl');
const CSV     = path.join(ROOT, 'data/dm-classified.csv');
const STREAMS = path.join(ROOT, 'data/person_streams.json');
const BACKUP  = path.join(ROOT, 'data/person_streams_backup_pre_recovery.json');

// ── HELPERS ────────────────────────────────────────────────────────────────────
function norm(s) { return (s||'').replace(/\s+/g,' ').trim(); }

function simpleHash(s) {
    let h = 0;
    for (let i = 0; i < Math.min(s.length, 120); i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h).toString(36).padStart(7, '0');
}

function parseCSV(text) {
    const rows=[]; let row=[],field='',inQ=false;
    for(let i=0;i<text.length;i++){
        const c=text[i];
        if(inQ){
            if(c==='"'&&text[i+1]==='"'){field+='"';i++;}
            else if(c==='"'){inQ=false;} else field+=c;
        } else {
            if(c==='"') inQ=true;
            else if(c===','){row.push(field);field='';}
            else if(c==='\n'){row.push(field);rows.push([...row]);row=[];field='';}
            else if(c!=='\r') field+=c;
        }
    }
    if(field||row.length){row.push(field);rows.push(row);}
    return rows;
}

// Try to extract the lead's first name from Scott's messages.
// Scott regularly addresses people: "Hey, Arthur!", "@Kai", "see you then, Sam"
function extractNameFromScottMsgs(msgs) {
    const patterns = [
        /\bHey[,\s]+([A-Z][a-z]{2,12})[!.,\s]/,
        /\bhi[,\s]+([A-Z][a-z]{2,12})[!.,\s]/i,
        /\bsee you[,\s]+(?:then[,\s]+)?([A-Z][a-z]{2,12})[!.,\s]/i,
        /\bI'll see you[,\s]+(?:then[,\s]+)?([A-Z][a-z]{2,12})[!.,\s]/i,
        /\bready[,\s]+(?:for[,\s]+our[,\s]+call[,\s]+)?([A-Z][a-z]{2,12})[!?,\s]/,
        /\b([A-Z][a-z]{2,12})[,!]\s+(?:bro|brother|man|king)/,
        /^@([A-Z][a-z]{2,12})\b/m,
    ];
    const SKIP = new Set(['The','And','But','For','Let','Are','You','Not','Was','Had','Has',
                          'Its','Its','Yes','Bro','Man','Hey','Got','Bali','This','What',
                          'That','With','From','They','Been','Will','When','Your','Come',
                          'Have','Into','Just','Love','Only','Over','Said','Some','Than',
                          'Then','They','This','Time','Very','Want','Well','Were','We\'re',
                          'Also','Back','Been','Both','Down','Each','Here','High','Kind']);
    for (const m of msgs) {
        if (m.role !== 'assistant') continue;
        const text = m.content || '';
        for (const pat of patterns) {
            const match = text.match(pat);
            if (match) {
                const name = match[1];
                if (name && name.length >= 3 && !SKIP.has(name)) return name;
            }
        }
    }
    return null;
}

// ── LOAD ───────────────────────────────────────────────────────────────────────
console.log('Loading dm-classified.csv …');
const csvRows = parseCSV(fs.readFileSync(CSV,'utf8'));
const csvHeader = csvRows[0];
const iMsg = csvHeader.indexOf('Message');

// Index all CSV message texts (normalized + first-80 + per-line variants)
const csvTextSet = new Set();
for (let i=1; i<csvRows.length; i++) {
    const msg = norm(csvRows[i][iMsg]||'');
    if (!msg) continue;
    csvTextSet.add(msg);
    csvTextSet.add(msg.substring(0,80));
    msg.split('\n').map(l=>norm(l)).filter(Boolean).forEach(l => {
        csvTextSet.add(l);
        csvTextSet.add(l.substring(0,80));
    });
}
console.log('  CSV message variants indexed:', csvTextSet.size);

console.log('Loading person_streams.json …');
const streamsDoc = JSON.parse(fs.readFileSync(STREAMS,'utf8'));
const streams    = streamsDoc.streams;

console.log('Loading finetune_data_v5.jsonl …');
const jsonlLines = fs.readFileSync(JSONL,'utf8').trim().split('\n');

// ── DETECT ORPHANED CONVERSATIONS ──────────────────────────────────────────────
function allMsgTexts(entry) {
    const texts = [];
    for (const m of (entry.messages||[])) {
        if (m.role === 'system') continue;
        const raw = norm(m.content||'');
        texts.push(raw);
        texts.push(raw.substring(0,80));
        raw.split('\n').map(l=>norm(l)).filter(Boolean).forEach(l => {
            texts.push(l);
            texts.push(l.substring(0,80));
        });
    }
    return texts;
}

function isInCSV(entry) {
    return allMsgTexts(entry).some(t => t.length > 3 && csvTextSet.has(t));
}

// Collect DM entries
const dmEntries = [];
for (const line of jsonlLines) {
    let d; try { d = JSON.parse(line.trim()); } catch(e) { continue; }
    const msgs = d.messages||[];
    if (msgs.length < 2) continue;
    const fu = (msgs[1]||{}).content||'';
    if (fu.includes('--- POST ---') || fu.includes('--- NEW MEMBER ---')) continue;
    dmEntries.push(d);
}

const orphanedEntries = dmEntries.filter(e => !isInCSV(e));
console.log(`\nTotal DM JSONL entries:   ${dmEntries.length}`);
console.log(`Matched to CSV:           ${dmEntries.length - orphanedEntries.length}`);
console.log(`Orphaned (not in CSV):    ${orphanedEntries.length}`);

if (orphanedEntries.length === 0) {
    console.log('\n✅  No orphaned conversations found. Nothing to recover.');
    process.exit(0);
}

// ── GROUP INTO UNIQUE CONVERSATIONS ───────────────────────────────────────────
// Key = hash of the earliest known messages in the conversation.
// When multiple entries share context (same early messages), merge them,
// keeping the one with the most turns to get the widest context window.
const convMap = new Map(); // hash → { msgs, leadName, entryCount }

for (const entry of orphanedEntries) {
    const msgs = (entry.messages||[]).filter(m=>m.role!=='system');
    if (!msgs.length) continue;

    // Use first two messages as conversation fingerprint
    const fp = msgs.slice(0,2).map(m=>norm(m.content||'').substring(0,60)).join('||');
    const hash = simpleHash(fp);

    if (!convMap.has(hash)) {
        convMap.set(hash, {
            msgs,
            leadName: extractNameFromScottMsgs(msgs) || null,
            entryCount: 1,
        });
    } else {
        const existing = convMap.get(hash);
        existing.entryCount++;
        // Keep the version with more context
        if (msgs.length > existing.msgs.length) {
            existing.msgs = msgs;
            // Try name again with richer context
            if (!existing.leadName) existing.leadName = extractNameFromScottMsgs(msgs);
        }
    }
}

console.log(`Unique orphaned conversations: ${convMap.size}`);

const namedCount   = [...convMap.values()].filter(c=>c.leadName).length;
const unnamedCount = convMap.size - namedCount;
console.log(`  Named (lead name extracted): ${namedCount}`);
console.log(`  Unnamed (will use ID):       ${unnamedCount}`);

if (DRY) {
    console.log('\n── Sample orphaned conversations (first 8) ──────────────────────');
    let i = 0;
    for (const [hash, conv] of convMap) {
        if (i++ >= 8) break;
        const label = conv.leadName ? `"${conv.leadName}"` : `(unnamed — id: recovered:${hash})`;
        console.log(`\n  [${i}] Lead: ${label}  (${conv.entryCount} JSONL entries, ${conv.msgs.length} msgs in best window)`);
        for (const m of conv.msgs.slice(0,4)) {
            console.log(`    [${m.role}] ${norm(m.content||'').substring(0,80)}`);
        }
    }
    console.log('\n(--dry mode: no files were modified)');
    process.exit(0);
}

// ── INJECT RECOVERED EVENTS ────────────────────────────────────────────────────
// Sentinel timestamp: Jan 2020, spaced 30 min per conversation, 30 sec per message.
// This puts recovered events safely before all real DMs (which start Nov 2025).
const BASE_TS   = new Date('2020-01-01T00:00:00.000Z').getTime();
let convIdx     = 0;
let injectedConvs  = 0;
let injectedEvents = 0;
let mergedIntoExisting = 0;

for (const [hash, conv] of convMap) {
    const { msgs, leadName } = conv;

    // Determine stream ID: if we know the name, try to find an existing stream
    let pid = null;
    if (leadName) {
        const normName = leadName.toLowerCase();
        // Look for an existing stream whose displayName contains this name
        for (const [existingPid, st] of Object.entries(streams)) {
            const dn = (st.person.displayName||'').toLowerCase();
            if (dn.includes(normName) || normName.includes(dn.split(' ')[0])) {
                pid = existingPid;
                mergedIntoExisting++;
                break;
            }
        }
    }
    // No match — create a new recovered stream
    if (!pid) {
        pid = `recovered:${hash}`;
        if (!streams[pid]) {
            streams[pid] = {
                person: {
                    id: pid,
                    slug: null,
                    displayName: leadName || `Recovered Lead ${hash}`,
                    displayAliases: leadName ? [leadName] : [],
                    gender: 'unknown',
                    role: 'lead',
                    sources: ['recovered_jsonl'],
                },
                events: [],
                excludeFromTraining: false,
            };
        }
    }

    const stream = streams[pid];

    let msgOffset = 0;
    for (const m of msgs) {
        const isScott = m.role === 'assistant';
        const ts = new Date(BASE_TS + convIdx * 30*60*1000 + msgOffset * 30*1000).toISOString();
        const rawText = norm(m.content||'');

        // Split \n-joined bubble-merged Scott messages into individual events
        const parts = isScott
            ? rawText.split('\n').map(l=>norm(l)).filter(Boolean)
            : [rawText];

        parts.forEach((text, partIdx) => {
            if (!text) return;
            stream.events.push({
                ts,
                ts_source: 'recovered_from_jsonl',
                channel: 'dm',
                direction: isScott ? 'from_scott' : 'from_person',
                speaker: isScott ? 'scott' : 'lead',
                text,
                recoveredFromJsonl: true,
                bubbleIdx: partIdx,
            });
            injectedEvents++;
        });
        msgOffset++;
    }
    injectedConvs++;
    convIdx++;
}

// Re-sort events in all affected streams (recovered events go to 2020, before real DMs)
for (const stream of Object.values(streams)) {
    if (stream.events.some(e=>e.recoveredFromJsonl)) {
        stream.events.sort((a,b)=>a.ts<b.ts?-1:a.ts>b.ts?1:0);
    }
}

// ── UPDATE COUNTS + SAVE ───────────────────────────────────────────────────────
streamsDoc.counts.persons     = Object.keys(streams).length;
streamsDoc.counts.totalEvents = Object.values(streams).reduce((s,st)=>s+st.events.length,0);
streamsDoc.generatedAt        = new Date().toISOString();

if (!fs.existsSync(BACKUP)) {
    console.log(`\nBacking up to ${path.basename(BACKUP)} …`);
    fs.writeFileSync(BACKUP, fs.readFileSync(STREAMS));
} else {
    console.log(`\nBackup already exists (${path.basename(BACKUP)}) — skipping.`);
}

const tmp = STREAMS + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(streamsDoc, null, 2));
fs.renameSync(tmp, STREAMS);

console.log(`\n✅  Recovery complete`);
console.log(`   Conversations injected:        ${injectedConvs}`);
console.log(`   Events injected:               ${injectedEvents}`);
console.log(`   Merged into existing streams:  ${mergedIntoExisting}`);
console.log(`   New recovered: streams:        ${injectedConvs - mergedIntoExisting}`);
console.log(`   Total persons:                 ${streamsDoc.counts.persons}`);
console.log(`   Total events:                  ${streamsDoc.counts.totalEvents}`);
