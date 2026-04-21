#!/usr/bin/env node
/**
 * bot/prelabel_dms.js
 *
 * Uses GPT to pre-label all DM entries in finetune_data_v5.jsonl.
 * Scott then loads dm_prelabeled.json into dm_tagger.html and just
 * reviews / corrects instead of labeling 4,810 entries from scratch.
 *
 * Usage:
 *   node prelabel_dms.js [path/to/finetune_data_v5.jsonl] [output.json]
 *
 * Defaults to ../data/finetune_data_v5.jsonl (the full 5,240-entry dataset).
 *
 * The script is RESUMABLE — re-run after interruption and it skips
 * entries that were already labeled in the output file.
 *
 * WhatsApp detection: any DM conversation where the content contains
 * WhatsApp signals (see WHATSAPP_SIGNALS below) is fully classified by the model
 * for tone/intent/sales_stage, but dm_stage is forced to null (nonsales=true).
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const JSONL_PATH    = process.argv[2] || path.join(__dirname, '../data/finetune_data_v5.jsonl');
const OUTPUT_PATH   = process.argv[3] || path.join(path.dirname(JSONL_PATH), 'dm_prelabeled.json');
const MODEL         = process.env.CLASSIFIER_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CONCURRENCY   = parseInt(process.env.CONCURRENCY || '5', 10);  // parallel API calls
const SAVE_EVERY    = 25;  // save to disk every N completions

// Shared rate-limit state across all workers — when one worker hits 429,
// all workers pause together instead of hammering the API simultaneously.
let rateLimitedUntil = 0;  // epoch ms — workers wait until this time before retrying

// ── WHATSAPP DETECTION ─────────────────────────────────────────────────────────
// DM conversations matching these patterns are still fully classified by the model,
// but their dm_stage is forced to null (nonsales=true) after classification.
const WHATSAPP_SIGNALS = [
    /\bwhatsapp\b/i,
    /\bwhats app\b/i,
    /\bwa\b.*\bchat\b/i,
    /\btelegram\b/i,
    /send.*on (whatsapp|wa|telegram)/i,
    /chat.*on (whatsapp|wa|telegram)/i,
    /message.*on (whatsapp|wa|telegram)/i,
    /SITUATION:\s*WhatsApp/i,
];

function isWhatsApp(allText) {
    return WHATSAPP_SIGNALS.some(re => re.test(allText));
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

// ── PARSE JSONL ────────────────────────────────────────────────────────────────
function parseDMs(filePath) {
    console.log(`Reading ${filePath}…`);
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const dms = [];

    let lineIdx = 0;
    for (const line of lines) {
        let d;
        try { d = JSON.parse(line.trim()); } catch (e) { lineIdx++; continue; }

        const msgs = d.messages || [];
        if (msgs.length < 2) { lineIdx++; continue; }

        // Skip post/comment and new-member entries
        const firstUser = (msgs[1] || {}).content || '';
        if (firstUser.includes('--- POST ---') || firstUser.includes('--- NEW MEMBER ---')) { lineIdx++; continue; }

        // The last assistant message is what we classify
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') { lastAssistantIdx = i; break; }
        }
        if (lastAssistantIdx < 0) { lineIdx++; continue; }

        const lastMsg    = msgs[lastAssistantIdx];
        const scottReply = (lastMsg.content || '').trim();
        if (!scottReply) { lineIdx++; continue; }

        // Use line index as the key — reply content is NOT unique (Scott sends
        // identical short replies to many different people, causing collisions).
        const key = `line_${String(lineIdx).padStart(5, '0')}`;

        // Full conversation text (for WhatsApp detection)
        const allText = msgs.map(m => m.content || '').join('\n');

        // Try to infer lead name from first user message
        const leadName = extractLeadName(msgs);

        // Build context: last 4 turns before Scott's reply
        const histStart = Math.max(1, lastAssistantIdx - 3);
        const history = [];
        for (let i = histStart; i < lastAssistantIdx; i++) {
            const speaker = msgs[i].role === 'assistant' ? 'Scott' : (leadName || 'Lead');
            const text = (msgs[i].content || '').substring(0, 250);
            history.push(`${speaker}: ${text}`);
        }

        dms.push({
            key,
            leadName: leadName || 'Lead',
            context: history.join('\n'),
            reply: scottReply.substring(0, 400),
            whatsapp: isWhatsApp(allText),
        });

        lineIdx++;
    }

    return dms;
}

function extractLeadName(msgs) {
    // Look for a line like "Name: ..." in user messages or system prompt
    for (const m of msgs) {
        if (m.role === 'system') {
            const match = (m.content || '').match(/Conversation with[:\s]+([A-Za-z]+)/i)
                       || (m.content || '').match(/DM from[:\s]+([A-Za-z]+)/i)
                       || (m.content || '').match(/Lead[:\s]+([A-Za-z]+)/i);
            if (match) return match[1];
        }
    }
    return null;
}

// ── CLASSIFY ONE DM ────────────────────────────────────────────────────────────
async function classify(dm) {
    const userContent = dm.context
        ? `[Prior messages]\n${dm.context}\n\n[Scott's reply — classify this]\n${dm.reply}`
        : `[Scott's reply — classify this]\n${dm.reply}`;

    const isNewModel = /^(o\d|gpt-5)/i.test(MODEL);
    const tokenParam = isNewModel
        ? { max_completion_tokens: 150 }
        : { max_tokens: 150 };

    const MAX_ATTEMPTS = 6;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // If another worker already set a global rate-limit pause, wait it out first
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
            if (!Array.isArray(parsed.tone_tags))     parsed.tone_tags = [];
            if (!parsed.intent)      parsed.intent      = '';
            if (!parsed.sales_stage) parsed.sales_stage = '';

            // WhatsApp conversations: full AI labeling but dm_stage always null
            if (dm.whatsapp) {
                parsed.nonsales      = true;
                parsed.dm_stage      = null;
                parsed.auto_whatsapp = true;
            } else {
                if (typeof parsed.nonsales !== 'boolean') parsed.nonsales = !parsed.dm_stage;
            }

            parsed.ai_suggested = true;
            parsed.lead_name    = dm.leadName;
            return parsed;

        } catch (err) {
            const is429 = err.status === 429 || /429|quota|rate.?limit/i.test(err.message);

            if (attempt === MAX_ATTEMPTS) {
                process.stdout.write(`\n  ✗ Failed after ${MAX_ATTEMPTS} attempts: ${err.message}\n`);
                return null;
            }

            if (is429) {
                // Exponential backoff: 15s, 30s, 60s, 120s, 240s
                // Also parse Retry-After header if available
                let retryAfterMs = Math.min(15000 * Math.pow(2, attempt - 1), 240000);
                const retryAfter = err.headers?.['retry-after'];
                if (retryAfter) retryAfterMs = Math.max(retryAfterMs, parseInt(retryAfter, 10) * 1000);

                // Set global pause so ALL workers back off together
                rateLimitedUntil = Date.now() + retryAfterMs;
                const retryAfterSec = Math.round(retryAfterMs / 1000);
                process.stdout.write(`\n  ⏳ Rate limited — all workers pausing ${retryAfterSec}s (attempt ${attempt}/${MAX_ATTEMPTS})\n`);
                await sleep(retryAfterMs);
            } else {
                // Non-429 error: short linear backoff
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
    if (!fs.existsSync(JSONL_PATH)) {
        console.error(`File not found: ${JSONL_PATH}`);
        console.error('');
        console.error('Usage:');
        console.error('  node prelabel_dms.js <path/to/finetune_data_v5.jsonl>');
        console.error('');
        console.error('Example:');
        console.error('  node prelabel_dms.js ../data/finetune_data_v5.jsonl');
        process.exit(1);
    }

    console.log('─────────────────────────────────────────');
    console.log('  DM Pre-Labeler');
    console.log('─────────────────────────────────────────');
    console.log(`  Model:  ${MODEL}`);
    console.log(`  Input:  ${JSONL_PATH}`);
    console.log(`  Output: ${OUTPUT_PATH}`);
    console.log('─────────────────────────────────────────\n');

    const dms = parseDMs(JSONL_PATH);
    const waCount = dms.filter(d => d.whatsapp).length;
    console.log(`Found ${dms.length} DM entries to label`);
    console.log(`  ↳ ${waCount} WhatsApp conversations → labeled normally but dm_stage forced null`);
    console.log(`  ↳ ${dms.length - waCount} regular Skool DMs`);
    console.log(`  ↳ All ${dms.length} will call ${MODEL}\n`);

    // Load existing progress (for resuming)
    let results = {};
    if (fs.existsSync(OUTPUT_PATH)) {
        try {
            const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
            results = existing.labels || {};
            const already = Object.keys(results).length;
            if (already > 0) {
                console.log(`Resuming — ${already} already labeled, skipping those\n`);
            }
        } catch (e) {
            console.log('Could not read existing output, starting fresh\n');
        }
    }

    const queue       = dms.filter(dm => !results[dm.key]);  // only unlabeled
    const total       = dms.length;
    const startAt     = Date.now();
    const alreadyDone = Object.keys(results).length;
    let   processed   = 0;
    let   failed      = 0;

    console.log(`Labeling ${queue.length} entries  ·  concurrency ${CONCURRENCY}\n`);

    // ── Rolling window for ETA (last 30 completions) ──────────────────────────
    const window = [];   // timestamps of recent completions
    const WINDOW_SIZE = 30;

    function printProgress() {
        const done      = alreadyDone + processed;
        const pct       = Math.round((done / total) * 100);
        const elapsed   = (Date.now() - startAt) / 1000;
        const remaining = total - done;

        // Rolling rate: avg ms per item over last WINDOW_SIZE completions
        let rateStr = '--';
        let etaStr  = '--';
        if (window.length >= 2) {
            const span    = (window[window.length - 1] - window[0]) / 1000;  // seconds
            const rate    = span / (window.length - 1);                       // sec/item
            const etaSec  = Math.round(remaining * rate);
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

    // ── Worker pool: CONCURRENCY workers pull from queue simultaneously ────────
    const iter = queue[Symbol.iterator]();
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (const dm of iter) {
            const label = await classify(dm);
            if (label) {
                results[dm.key] = label;
                processed++;
                window.push(Date.now());
                if (window.length > WINDOW_SIZE) window.shift();
            } else {
                failed++;
            }

            printProgress();

            if ((processed + failed) % SAVE_EVERY === 0 && (processed + failed) > 0) {
                saveResults(results, total);
            }
        }
    });

    // Save on Ctrl+C so progress is never lost mid-run
    process.on('SIGINT', () => {
        console.log('\n\n  Interrupted — saving progress…');
        saveResults(results, total);
        const done = Object.keys(results).length;
        console.log(`  Saved ${done}/${total} labels. Re-run to resume.\n`);
        process.exit(0);
    });

    await Promise.all(workers);

    const totalSec  = Math.round((Date.now() - startAt) / 1000);
    const totalTime = totalSec < 60   ? `${totalSec}s`
                    : totalSec < 3600 ? `${Math.floor(totalSec/60)}m ${totalSec%60}s`
                    :                   `${Math.floor(totalSec/3600)}h ${Math.floor((totalSec%3600)/60)}m`;

    saveResults(results, total);

    const finalLabels  = Object.values(results);
    const waLabeled    = finalLabels.filter(l => l.auto_whatsapp).length;
    const avgRate      = processed > 0 ? (totalSec / processed).toFixed(2) : '--';

    console.log(`\n\n✓ Done — ${Object.keys(results).length}/${total} labeled in ${totalTime}`);
    console.log(`  ↳ ${waLabeled} WhatsApp conversations labeled (dm_stage=null)`);
    console.log(`  ↳ avg ${avgRate}s/item via ${MODEL}${failed > 0 ? `  ·  ${failed} failed` : ''}`);
    console.log(`\n  Output saved to:\n  ${OUTPUT_PATH}`);
    console.log('\n  Next: drop dm_prelabeled.json into dm_tagger.html');
    console.log('        to apply AI suggestions before Scott reviews.\n');
}

function saveResults(results, total) {
    const out = {
        generated_at: new Date().toISOString(),
        model:        MODEL,
        total_dms:    total,
        labeled:      Object.keys(results).length,
        labels:       results,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});