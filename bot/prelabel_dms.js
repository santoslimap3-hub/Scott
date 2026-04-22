#!/usr/bin/env node
/**
 * bot/prelabel_dms.js
 *
 * Uses GPT to pre-label all of Scott's messages in data/dm_classified.json.
 * Tags are written back in-place to each Scott entry in the same file.
 *
 * Usage:
 *   node prelabel_dms.js [path/to/dm_classified.json]
 *
 * The script is RESUMABLE — re-run after interruption and it skips
 * entries that already have ai_suggested=true.
 *
 * Tags written to each Scott message:
 *   dm_stage    — primary sales stage of this reply (or null for non-sales)
 *   tone_tags   — 1-4 tone tags
 *   intent      — single primary intent
 *   sales_stage — funnel stage
 *   nonsales    — true if WhatsApp/personal/casual
 *   ai_suggested — always true (marks entry as already labeled)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const INPUT_PATH  = process.argv[2] || path.join(__dirname, '../data/dm_classified.json');
const MODEL       = process.env.CLASSIFIER_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const SAVE_EVERY  = 25;  // save to disk every N completions

// Shared rate-limit state across all workers
let rateLimitedUntil = 0;

// ── WHATSAPP DETECTION ─────────────────────────────────────────────────────────
const WHATSAPP_SIGNALS = [
    /\bwhatsapp\b/i,
    /\bwhats app\b/i,
    /\bwa\b.*\bchat\b/i,
    /\btelegram\b/i,
    /send.*on (whatsapp|wa|telegram)/i,
    /chat.*on (whatsapp|wa|telegram)/i,
    /message.*on (whatsapp|wa|telegram)/i,
];

function isWhatsApp(text) {
    return WHATSAPP_SIGNALS.some(re => re.test(text));
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────────
const SYSTEM = `You are a sales DM classifier. Classify Scott's REPLY in a DM conversation.

DM_STAGE — main purpose of Scott's reply (one string, or null):
null=not a sales DM (WhatsApp/personal/casual) | connect=open with specific hook/interest | gather-intel=learn their pain/history/situation | share-authority=personal story, vulnerability, expertise | frame-outcome=probe dream goal, steer toward business | offer-call=invite to diagnostic call | pre-qualify=probe budget $1K-$5K commitment | send-calendly=qualified+committed, send calendar link | nurture-free=not ready/no budget, offer free resources

TONE_TAGS — 1–4 tones present in Scott's reply (array):
hype | brotherhood | motivational | chit-chat | curiosity | empathy | authority | tough-love | mystery-teasing | teasing-future-value | vulnerability | humor | bonding-rapport | self-aggrandization | direct | storytelling | praise | gratitude | casual

INTENT — single primary intent (one string):
engagement-nurture | value-delivery | info-gathering | lead-qualification | authority-proofing | pain-agitation | objection-handling | close-to-call | funneling | social-proof | acknowledgement | community-building | redirect

SALES_STAGE — where the lead is in the funnel (one string):
awareness | engagement | nurture | ask

Return ONLY valid JSON, no markdown fences:
{"nonsales":bool,"dm_stage":"..."or null,"tone_tags":[...],"intent":"...","sales_stage":"..."}`;

// ── BUILD WORK ITEMS ───────────────────────────────────────────────────────────
// Groups the flat array by Contact, then for each Scott message builds a
// context window (up to 4 prior messages in the same conversation).
function buildWorkItems(entries) {
    // Group indices by Contact, preserving original array order
    const byContact = {};
    for (let i = 0; i < entries.length; i++) {
        const contact = entries[i].Contact || 'Unknown';
        if (!byContact[contact]) byContact[contact] = [];
        byContact[contact].push(i);
    }

    const items = [];

    for (const [contact, indices] of Object.entries(byContact)) {
        for (let pos = 0; pos < indices.length; pos++) {
            const idx   = indices[pos];
            const entry = entries[idx];

            // Only classify Scott's messages
            if (entry.Speaker !== 'Scott') continue;

            // Skip if already labeled
            if (entry.ai_suggested === true) continue;

            // Build context: up to 4 messages before this one in the same conversation
            const histStart = Math.max(0, pos - 4);
            const history   = [];
            for (let h = histStart; h < pos; h++) {
                const prev    = entries[indices[h]];
                const speaker = prev.Speaker === 'Scott' ? 'Scott' : (contact || 'Lead');
                history.push(`${speaker}: ${String(prev.Message || '').substring(0, 250)}`);
            }

            // WhatsApp detection: check the whole conversation text
            const allText = indices
                .slice(0, pos + 1)
                .map(i2 => String(entries[i2].Message || ''))
                .join('\n');

            items.push({
                idx,          // index in entries array — we write back here
                contact,
                reply: String(entry.Message || '').substring(0, 400),
                context: history.join('\n'),
                whatsapp: isWhatsApp(allText),
            });
        }
    }

    return items;
}

// ── CLASSIFY ONE MESSAGE ───────────────────────────────────────────────────────
async function classify(item) {
    const userContent = item.context
        ? `[Prior messages]\n${item.context}\n\n[Scott's reply — classify this]\n${item.reply}`
        : `[Scott's reply — classify this]\n${item.reply}`;

    const isNewModel = /^(o\d|gpt-5)/i.test(MODEL);
    const tokenParam = isNewModel
        ? { max_completion_tokens: 150 }
        : { max_tokens: 150 };

    const MAX_ATTEMPTS = 6;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const waitMs = rateLimitedUntil - Date.now();
        if (waitMs > 0) await sleep(waitMs);

        try {
            const res = await client.chat.completions.create({
                model:       MODEL,
                messages:    [
                    { role: 'system', content: SYSTEM },
                    { role: 'user',   content: userContent },
                ],
                ...tokenParam,
                temperature: 0,
            });

            const raw = (res.choices[0]?.message?.content || '').trim()
                .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
            const parsed = JSON.parse(raw);

            // Normalize
            if (!Array.isArray(parsed.tone_tags))     parsed.tone_tags   = [];
            if (!parsed.intent)                        parsed.intent      = '';
            if (!parsed.sales_stage)                   parsed.sales_stage = '';

            // WhatsApp: full AI labeling but dm_stage always null
            if (item.whatsapp) {
                parsed.nonsales      = true;
                parsed.dm_stage      = null;
                parsed.auto_whatsapp = true;
            } else {
                if (typeof parsed.nonsales !== 'boolean') parsed.nonsales = !parsed.dm_stage;
            }

            parsed.ai_suggested = true;
            return parsed;

        } catch (err) {
            const is429 = err.status === 429 || /429|quota|rate.?limit/i.test(err.message);

            if (attempt === MAX_ATTEMPTS) {
                process.stdout.write(`\n  ✗ Failed after ${MAX_ATTEMPTS} attempts: ${err.message}\n`);
                return null;
            }

            if (is429) {
                let retryAfterMs = Math.min(15000 * Math.pow(2, attempt - 1), 240000);
                const retryAfter = err.headers?.['retry-after'];
                if (retryAfter) retryAfterMs = Math.max(retryAfterMs, parseInt(retryAfter, 10) * 1000);
                rateLimitedUntil = Date.now() + retryAfterMs;
                const retryAfterSec = Math.round(retryAfterMs / 1000);
                process.stdout.write(`\n  ⏳ Rate limited — all workers pausing ${retryAfterSec}s (attempt ${attempt}/${MAX_ATTEMPTS})\n`);
                await sleep(retryAfterMs);
            } else {
                await sleep(2000 * attempt);
            }
        }
    }
}

// ── MAIN ───────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.OPENAI_API_KEY) {
        console.error('Error: OPENAI_API_KEY not set. Check your .env file.');
        process.exit(1);
    }
    if (!fs.existsSync(INPUT_PATH)) {
        console.error(`File not found: ${INPUT_PATH}`);
        console.error('Usage: node prelabel_dms.js [path/to/dm_classified.json]');
        process.exit(1);
    }

    console.log('─────────────────────────────────────────');
    console.log('  DM Auto-Labeler  →  dm_classified.json');
    console.log('─────────────────────────────────────────');
    console.log(`  Model:  ${MODEL}`);
    console.log(`  File:   ${INPUT_PATH}`);
    console.log('─────────────────────────────────────────\n');

    // Load the flat array
    let entries;
    try {
        entries = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
    } catch (e) {
        console.error('Could not parse dm_classified.json:', e.message);
        process.exit(1);
    }
    if (!Array.isArray(entries)) {
        console.error('dm_classified.json must be a JSON array.');
        process.exit(1);
    }

    const scottTotal = entries.filter(e => e.Speaker === 'Scott').length;
    const alreadyDone = entries.filter(e => e.Speaker === 'Scott' && e.ai_suggested === true).length;
    const waCount = entries.filter(e => e.Speaker === 'Scott' && e.auto_whatsapp === true).length;

    console.log(`Total entries:      ${entries.length}`);
    console.log(`Scott messages:     ${scottTotal}`);
    console.log(`Already labeled:    ${alreadyDone}`);
    console.log(`WhatsApp (so far):  ${waCount}\n`);

    // Build work items (skips already-labeled entries)
    const queue = buildWorkItems(entries);

    if (queue.length === 0) {
        console.log('✓ All Scott messages are already labeled. Nothing to do.\n');
        return;
    }

    console.log(`Labeling ${queue.length} entries  ·  concurrency ${CONCURRENCY}\n`);

    const total    = scottTotal;
    const startAt  = Date.now();
    let processed  = 0;
    let failed     = 0;

    // Rolling window for ETA
    const window      = [];
    const WINDOW_SIZE = 30;

    function printProgress() {
        const done      = alreadyDone + processed;
        const pct       = Math.round((done / total) * 100);
        const elapsed   = (Date.now() - startAt) / 1000;
        const remaining = total - done;

        let rateStr = '--';
        let etaStr  = '--';
        if (window.length >= 2) {
            const span   = (window[window.length - 1] - window[0]) / 1000;
            const rate   = span / (window.length - 1);
            const etaSec = Math.round(remaining * rate);
            rateStr = rate < 1 ? `${(1 / rate).toFixed(1)}/s` : `${rate.toFixed(1)}s/item`;
            etaStr  = etaSec < 60   ? `${etaSec}s`
                    : etaSec < 3600 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s`
                    :                 `${Math.floor(etaSec / 3600)}h ${Math.floor((etaSec % 3600) / 60)}m`;
        }

        const elapsedStr = elapsed < 60   ? `${Math.round(elapsed)}s`
                         : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s`
                         :                  `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;

        const failStr = failed > 0 ? `  ·  ${failed} failed` : '';
        process.stdout.write(
            `\r  [${done}/${total}] ${pct}%  ·  ${rateStr}  ·  elapsed ${elapsedStr}  ·  ETA ${etaStr}${failStr}   `
        );
    }

    // Save on Ctrl+C so progress is never lost mid-run
    process.on('SIGINT', () => {
        console.log('\n\n  Interrupted — saving progress…');
        saveFile(entries, INPUT_PATH);
        const done = entries.filter(e => e.Speaker === 'Scott' && e.ai_suggested === true).length;
        console.log(`  Saved ${done}/${total} labels. Re-run to resume.\n`);
        process.exit(0);
    });

    // Worker pool
    const iter = queue[Symbol.iterator]();
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (const item of iter) {
            const label = await classify(item);
            if (label) {
                // Write tags back into the entry in-place
                Object.assign(entries[item.idx], label);
                processed++;
                window.push(Date.now());
                if (window.length > WINDOW_SIZE) window.shift();
            } else {
                failed++;
            }

            printProgress();

            if ((processed + failed) % SAVE_EVERY === 0 && (processed + failed) > 0) {
                saveFile(entries, INPUT_PATH);
            }
        }
    });

    await Promise.all(workers);

    // Final save
    saveFile(entries, INPUT_PATH);

    const totalSec  = Math.round((Date.now() - startAt) / 1000);
    const totalTime = totalSec < 60   ? `${totalSec}s`
                    : totalSec < 3600 ? `${Math.floor(totalSec/60)}m ${totalSec%60}s`
                    :                   `${Math.floor(totalSec/3600)}h ${Math.floor((totalSec%3600)/60)}m`;

    const finalTagged = entries.filter(e => e.Speaker === 'Scott' && e.ai_suggested === true).length;
    const waLabeled   = entries.filter(e => e.Speaker === 'Scott' && e.auto_whatsapp === true).length;
    const avgRate     = processed > 0 ? (totalSec / processed).toFixed(2) : '--';

    console.log(`\n\n✓ Done — ${finalTagged}/${total} Scott messages labeled in ${totalTime}`);
    console.log(`  ↳ ${waLabeled} WhatsApp conversations labeled (dm_stage=null)`);
    console.log(`  ↳ avg ${avgRate}s/item via ${MODEL}${failed > 0 ? `  ·  ${failed} failed` : ''}`);
    console.log(`\n  Tags written to: ${INPUT_PATH}\n`);
}

function saveFile(entries, filePath) {
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
