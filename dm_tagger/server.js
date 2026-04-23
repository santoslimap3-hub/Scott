// Reuse express from the sibling tagger/ folder — no separate npm install needed
const express = require(require('path').join(__dirname, '..', 'tagger', 'node_modules', 'express'));
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const app = express();
const PORT = 3001;

const JSONL_FILE = path.join(__dirname, '..', 'data', 'fine_tune', 'finetune_data_v5.jsonl');
const PRELABELS_FILE = path.join(__dirname, '..', 'data', 'fine_tune', 'dm_prelabeled.json');
const CORRECTIONS_FILE = path.join(__dirname, '..', 'data', 'dms', 'scott_dm_corrections.json');
const VIEWS_DIR = path.join(__dirname, '..', 'views');

app.use(express.json({ limit: '100mb' }));
app.use(express.static(VIEWS_DIR));

// ─── STAGE descriptions (same wording used in finetune_data_v5.jsonl) ─────────
// These are appended to "STAGE: <value> — <description>" in the system prompt.
const STAGE_DESCS = {
    'awareness': "They just arrived. Welcome warmly, make them feel seen. No selling.",
    'engagement': "They're interested. Start qualifying and showing what's possible. Match their energy and start painting the picture of transformation.",
    'nurture': "You're warming them up. No selling. Build trust, drop value, create intrigue. Make them curious about who's behind all this knowledge.",
    'ask': "They're ready or close to ready. Move toward booking a diagnosis call with Scott. Make it feel like an opportunity, not a pitch.",
};

// DM workflow stage → sales_stage mapping (for updating STAGE in system prompt)
// The tagger uses dm_stage (granular) and sales_stage (funnel level) separately.
// In the JSONL system prompt only sales_stage is used as "STAGE:".
const SALES_STAGE_DESCS = {
    'awareness': STAGE_DESCS['awareness'],
    'engagement': STAGE_DESCS['engagement'],
    'nurture': STAGE_DESCS['nurture'],
    'ask': STAGE_DESCS['ask'],
};

// ─── Serve dm_tagger.html as root ────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dm_tagger.html'));

// ─── Load DM entries from JSONL ───────────────────────────────────────────────
// Reads DM conversation entries from finetune_data_v5.jsonl, filtering out
// post/comment replies and first-DM entries so only multi-turn DM convos remain.
app.get('/api/dms', (req, res) => {
    try {
        const entries = [];
        const raw = fs.readFileSync(JSONL_FILE, 'utf-8');
        const lines = raw.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let d;
            try { d = JSON.parse(trimmed); } catch (e) { continue; }
            const msgs = d.messages || [];
            if (msgs.length < 3) continue;
            // Skip post/comment replies and first-DM welcome entries
            const firstUser = (msgs[1] || {}).content || '';
            if (firstUser.includes('--- POST ---') || firstUser.includes('--- NEW MEMBER ---')) continue;
            // Last message must be from the assistant (Scott's reply)
            const lastMsg = msgs[msgs.length - 1];
            if (!lastMsg || lastMsg.role !== 'assistant') continue;
            entries.push(d);
        }
        res.json({ count: entries.length, entries });
    } catch (err) {
        console.error('Error reading JSONL:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Load pre-labels from dm_prelabeled.json (written by prelabel_dms.js) ────
app.get('/api/prelabels', (req, res) => {
    try {
        if (!fs.existsSync(PRELABELS_FILE)) {
            return res.json({ exists: false, labeled: 0, labels: {} });
        }
        const data = JSON.parse(fs.readFileSync(PRELABELS_FILE, 'utf-8'));
        res.json({
            exists: true,
            labeled: data.labeled || Object.keys(data.labels || {}).length,
            generated_at: data.generated_at || null,
            model: data.model || null,
            labels: data.labels || {},
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Update JSONL entries + save audit log ────────────────────────────────────
// Body: { correction_id, timestamp, lead_name, scott_reply, last_10_messages,
//         previous_tags, new_tags }
//
// Strategy:
//   1. Read the whole JSONL into memory (array of lines).
//   2. Find every line whose last assistant message matches scott_reply (by key).
//   3. Rewrite the SITUATION block in the system prompt with the corrected tags.
//   4. Write the full file back atomically (temp file + rename).
//   5. Append to scott_dm_corrections.json as an audit log.
//
app.post('/api/corrections', (req, res) => {
    try {
        const correction = req.body;
        if (!correction || !correction.new_tags || !correction.scott_reply) {
            return res.status(400).json({ error: 'Invalid correction payload' });
        }

        const { scott_reply, new_tags } = correction;
        const replyKey = scott_reply.substring(0, 80).trim().replace(/\s+/g, ' ');

        // ── 1. Read all lines ────────────────────────────────────────────────
        const raw = fs.readFileSync(JSONL_FILE, 'utf-8');
        const lines = raw.split('\n');
        let updated = 0;

        // ── 2 & 3. Find matching lines and rewrite their system prompts ──────
        const newLines = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed) return line;

            let d;
            try { d = JSON.parse(trimmed); } catch (e) { return line; }

            const msgs = d.messages || [];
            if (msgs.length < 2) return line;

            // Skip non-DM entries
            const firstUser = (msgs[1] || {}).content || '';
            if (firstUser.includes('--- POST ---') || firstUser.includes('--- NEW MEMBER ---')) return line;

            // Find last assistant message
            let lastAssistantContent = '';
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') {
                    lastAssistantContent = (msgs[i].content || '').trim();
                    break;
                }
            }

            const lineKey = lastAssistantContent.substring(0, 80).trim().replace(/\s+/g, ' ');
            if (lineKey !== replyKey) return line;

            // ── Rewrite the SITUATION block in system prompt ─────────────────
            const sys = msgs[0];
            if (!sys || sys.role !== 'system') return line;

            sys.content = rewriteSystemPrompt(sys.content, new_tags);
            updated++;
            return JSON.stringify(d);
        });

        if (updated === 0) {
            return res.status(404).json({ error: 'No matching JSONL entries found for this reply', key: replyKey });
        }

        // ── 4. Write back atomically ──────────────────────────────────────────
        const tmpFile = JSONL_FILE + '.tmp';
        fs.writeFileSync(tmpFile, newLines.join('\n'), 'utf-8');
        fs.renameSync(tmpFile, JSONL_FILE);

        // ── 5. Append to audit log ────────────────────────────────────────────
        let corrections = [];
        if (fs.existsSync(CORRECTIONS_FILE)) {
            try { corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf-8')); } catch (e) {}
        }
        const existingIdx = corrections.findIndex(c => c.correction_id === correction.correction_id);
        if (existingIdx !== -1) corrections[existingIdx] = correction;
        else corrections.push(correction);
        fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(corrections, null, 2));

        console.log(`[update] "${replyKey.substring(0,50)}…" — updated ${updated} JSONL line(s), ${corrections.length} total corrections`);
        res.json({ updated_lines: updated, total_corrections: corrections.length });

    } catch (err) {
        console.error('Error updating JSONL:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Rewrite the SITUATION/STAGE/INTENT/TONE block in a system prompt string ──
function rewriteSystemPrompt(content, tags) {
    // Find where SITUATION: starts — everything before it stays untouched
    const sitIdx = content.indexOf('\nSITUATION:');
    if (sitIdx === -1) return content; // unexpected format, leave alone

    const before = content.substring(0, sitIdx);

    // Build the new SITUATION block
    const lines = ['\nSITUATION: DM conversation on Skool.'];

    // STAGE — use sales_stage (funnel level) for the system prompt
    if (tags.sales_stage && SALES_STAGE_DESCS[tags.sales_stage]) {
        lines.push(`STAGE: ${tags.sales_stage} — ${SALES_STAGE_DESCS[tags.sales_stage]}`);
    }

    // INTENT (only add if present — DM entries didn't originally have it, but
    // corrected ones will be enriched with it going forward)
    if (tags.intent) {
        lines.push(`INTENT: ${tags.intent}`);
    }

    // TONE (only add if any tones selected)
    if (Array.isArray(tags.tone_tags) && tags.tone_tags.length > 0) {
        lines.push(`TONE: ${tags.tone_tags.join(', ')}`);
    }

    return before + lines.join('\n');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
    try {
        const corrections = fs.existsSync(CORRECTIONS_FILE) ?
            JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf-8')) : [];
        const prelabelExists = fs.existsSync(PRELABELS_FILE);
        let prelabelCount = 0;
        if (prelabelExists) {
            try {
                const pl = JSON.parse(fs.readFileSync(PRELABELS_FILE, 'utf-8'));
                prelabelCount = pl.labeled || Object.keys(pl.labels || {}).length;
            } catch (e) {}
        }
        res.json({
            corrections_count: corrections.length,
            prelabels_count: prelabelCount,
            prelabels_exists: prelabelExists,
            corrections_file: CORRECTIONS_FILE,
            jsonl_file: JSONL_FILE,
            prelabels_file: PRELABELS_FILE,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    const plExists = fs.existsSync(PRELABELS_FILE);
    let plCount = 0;
    if (plExists) {
        try {
            const pl = JSON.parse(fs.readFileSync(PRELABELS_FILE, 'utf-8'));
            plCount = pl.labeled || Object.keys(pl.labels || {}).length;
        } catch (e) {}
    }
    const plStatus = plExists ? `${plCount} AI labels ready` : 'not found (run prelabel_dms.js)';

    console.log('');
    console.log('  ┌─────────────────────────────────────────────────┐');
    console.log(`  │  DM Tagger  →  http://localhost:${PORT}/             │`);
    console.log('  │                                                 │');
    console.log(`  │  JSONL       →  finetune_data_v5.jsonl          │`);
    console.log(`  │  Pre-labels  →  ${plStatus.padEnd(32)} │`);
    console.log(`  │  Corrections →  scott_dm_corrections.json       │`);
    console.log('  └─────────────────────────────────────────────────┘');
    console.log('');
});