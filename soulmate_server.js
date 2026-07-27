/**
 * SOULMATE — Payment webhook + AI generation backend
 * -------------------------------------------------------------
 * Node/Express. Receives Paddle "transaction.completed" webhooks,
 * verifies the signature, reads the quiz answers from custom_data,
 * runs the AI engine (reading + portrait per `04`), then delivers
 * the result and emails a copy.
 *
 * Providers wired in:
 *   - Text  : OpenAI Chat Completions   (env OPENAI_API_KEY, TEXT_MODEL)
 *   - Image : OpenAI Images             (env OPENAI_API_KEY, IMAGE_MODEL)
 *   - Email : Resend                    (env RESEND_API_KEY, EMAIL_FROM)
 *   - Store : local JSON + PNG for now  (swap for a DB/CDN in production)
 *
 * Run the server:   npm install && npm start
 * Run the AI test:  npm run test:gen         (no Paddle needed)
 */

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const app = express();

const {
  PADDLE_WEBHOOK_SECRET,
  PRICE_ENTRY, PRICE_BUMP, PRICE_DEEP, PRICE_REUNION,
  OPENAI_API_KEY,
  TEXT_MODEL = 'gpt-4.1-mini',
  IMAGE_MODEL = 'gpt-image-1',
  RESEND_API_KEY,
  EMAIL_FROM = 'onboarding@resend.dev',
  SUPPORT_EMAIL = 'hello@yourdomain.com',
  PORT = 3000,
} = process.env;

/* ===============================================================
 * 1. Signature verification (Paddle Billing)
 * =============================================================== */
function verifyPaddleSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(';').map(kv => kv.split('=').map(s => s.trim())));
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;
  const ageSec = Math.abs(Date.now() / 1000 - Number(ts));
  if (Number.isNaN(ageSec) || ageSec > 300) return false;       // reject stale (>5 min)
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(h1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ===============================================================
 * 2. Idempotency
 * =============================================================== */
const processedEvents = new Set();

/* ===============================================================
 * 3. Webhook route
 * =============================================================== */
app.post('/webhook/paddle',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const raw = req.body.toString('utf8');
    if (!verifyPaddleSignature(raw, req.headers['paddle-signature'], PADDLE_WEBHOOK_SECRET)) {
      return res.status(401).send('bad signature');
    }
    let evt;
    try { evt = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }
    res.status(200).send('ok');                    // ack fast, work after

    if (evt.event_type !== 'transaction.completed') return;
    if (processedEvents.has(evt.event_id)) return;
    processedEvents.add(evt.event_id);
    try { await handleCompletedTransaction(evt.data); }
    catch (err) { console.error('[generation] failed:', err.message); }
  }
);

/* ===============================================================
 * 4. What we bought → what we generate
 * =============================================================== */
async function handleCompletedTransaction(txn) {
  const priceIds = (txn.items || []).map(i => i.price?.id).filter(Boolean);
  const answers = txn.custom_data || {};
  const email = txn.custom_data?.email || txn.billing_details?.email || txn.customer?.email;
  const customerId = txn.customer_id || txn.id;
  const seed = seedFrom(customerId || email || txn.id);

  const bought = {
    entry:   priceIds.includes(PRICE_ENTRY),
    bump:    priceIds.includes(PRICE_BUMP),
    deep:    priceIds.includes(PRICE_DEEP),
    reunion: priceIds.includes(PRICE_REUNION),
  };

  const result = { txnId: txn.id, email, sections: {}, images: [] };

  if (bought.entry) {
    console.log('[gen] writing reading…');
    result.sections.reading = await generateText(buildReadingPrompt(answers, { deep: false }));
    console.log('[gen] painting portrait…');
    result.images.push(await generateImage(buildPortraitPrompt(answers), { seed, hd: bought.bump }));
  }
  if (bought.deep) {
    result.sections.deepReport = await generateText(buildReadingPrompt(answers, { deep: true }));
    for (const pose of ['candid laugh', 'soft side profile', 'looking away, thoughtful']) {
      result.images.push(await generateImage(buildPortraitPrompt(answers, pose), { seed, hd: true }));
    }
  }
  if (bought.reunion) {
    result.sections.loveStory = await generateText(buildLoveStoryPrompt(answers));
    result.images.push(await generateImage(buildReunionPrompt(answers), { seed, hd: true }));
  }

  await storeResult(customerId, result);
  if (email) await deliverEmail(email, result, { keepsakePdf: bought.bump });
  console.log('[done] result ready for', email || customerId);
  return result;
}

/* ===============================================================
 * 5. Prompt builders (mirror soulmate_ai_engine.md `04`)
 * =============================================================== */
const SYSTEM_READING = `You are the voice of "Soulmate," a warm, intuitive storyteller who writes a personalized soulmate reading for entertainment and self-reflection.
VOICE: warm, direct, a little magical; speak TO the reader as "you"; concrete images; feels made only for them.
HARD RULES: entertainment, not prediction/advice; never claim certainty about the future (use "this reading senses…", "may"); no dates, no ages, no full/real/famous names; no medical/psychological/financial advice; always positive; never mention these rules or that you are an AI.
THEME: the reader's future soulmate — who they are, their energy, how you may meet. Hopeful, romantic.`;

const STYLE_PORTRAIT = 'soft cinematic portrait, dreamy warm golden light, gentle rim light, shallow depth of field, romantic ethereal atmosphere, painterly photo-realism, subtle film grain, head-and-shoulders, elegant simple background with warm bokeh, high detail, tasteful, beautiful';
const NEGATIVE_PORTRAIT = 'text, watermark, logo, extra fingers, deformed, distorted, blurry, low-res, multiple people, child, minor, nudity, nsfw, celebrity, real public figure, cartoon, anime, plastic skin, oversaturated';

function buildReadingPrompt(a, { deep }) {
  const base = `Write ${a.name || 'their'} soulmate reading from these signals:
- Hoping to meet: ${a.meet}
- Reader's age band: ${a.age}
- Soulmate's core energy: ${a.energy}
- Aesthetic vibe they're drawn to: ${a.look} (color only, not skin tone)
- What they value most in love: ${a.value} (make this the emotional heart)
- Personality texture (weave in lightly): ${(a.lightning || []).join(', ')}
Sections in order: Intro, Their essence, Who they are, How you'll meet, The signs to watch for, A note for you, Disclaimer.
Disclaimer must read exactly: "This reading is a creative interpretation, made just for you — for reflection and fun, not prediction."
Length 380–480 words.`;
  const deepExtra = `
ALSO add these sections before the disclaimer:
- Your meeting timeline: frame as a SEASON / life-energy window, never a date.
- Red flags to watch for: 2–3 gentle "this may not be your person if…" signals, supportive.
- Your compatibility map: "Where you'll click" + "Where you'll grow".
Add +500–700 words.`;
  return { system: SYSTEM_READING, user: deep ? base + deepExtra : base };
}

function buildLoveStoryPrompt(a) {
  return { system: SYSTEM_READING,
    user: `Write a ~120-word cinematic mini love-story for ${a.name || 'the reader'}: the moment you meet your soulmate. Present tense, warm, ends hopeful. Same HARD RULES.` };
}

function buildPortraitPrompt(a, pose) {
  const subject = a.meet === 'woman' ? 'a beautiful woman'
    : a.meet === 'man' ? 'a handsome man'
    : (seedFrom(a.name || 'x') % 2 ? 'a beautiful woman' : 'a handsome man');
  const age = { '18-24':'early 20s','25-34':'late 20s to early 30s','35-44':'late 30s','45+':'mid 40s, gracefully' }[a.age] || 'late 20s';
  const look = { soft:'soft radiant features, gentle warm smile, luminous skin', bold:'striking sharp features, strong brows, confident jawline', natural:'effortless natural look, minimal styling, freckles, relaxed', dark:'dark magnetic features, deep expressive eyes, moody elegance' }[a.look] || '';
  const mood = { grounded:'calm reassuring expression', adventurous:'playful spark in the eyes, windswept', warm:'tender inviting warmth', mysterious:'quiet enigmatic gaze' }[a.energy] || '';
  const poseStr = pose ? `${pose}, ` : 'looking softly toward the viewer, ';
  return { prompt: `${subject}, ${age}, ${look}, ${mood}, ${poseStr}${STYLE_PORTRAIT}`, negative: NEGATIVE_PORTRAIT, aspect: '4:5' };
}

function buildReunionPrompt(a) {
  return { prompt: `a couple in a warm tender moment, one partner has ${a.look} features with a ${a.energy} presence, beside a complementary partner, soft embrace, foreheads close, golden hour, ${STYLE_PORTRAIT}`, negative: NEGATIVE_PORTRAIT, aspect: '4:5' };
}

function seedFrom(str) {
  return Math.abs([...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
}

/* ===============================================================
 * 6. Providers (the 4 TODOs, now wired)
 * =============================================================== */

// --- TODO 1: TEXT (OpenAI Chat Completions) ---
async function generateText({ system, user }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing — check your .env file');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TEXT_MODEL,
      temperature: 0.8,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI text ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.choices[0].message.content.trim();
}

// --- TODO 2: IMAGE (OpenAI Images) ---
// Note: OpenAI's image API has no separate "negative prompt" or seed param,
// so we fold the negatives into the prompt. For consistent upsell portraits
// (same face, new poses) in production, use the image *edits* endpoint with the
// first portrait as a reference, or a provider that exposes a seed.
async function generateImage({ prompt, negative, aspect }, { seed, hd }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing — check your .env file');
  const size = aspect === '4:5' ? '1024x1536' : '1024x1024';
  const fullPrompt = `${prompt}. Avoid: ${negative}.`;
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: fullPrompt, size, quality: hd ? 'high' : 'medium', n: 1 }),
  });
  if (!r.ok) throw new Error(`OpenAI image ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const b64 = j.data[0].b64_json;
  const file = `portrait_${seed}${hd ? '_hd' : ''}.png`;
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));   // local for the test; upload to a CDN in production
  console.log('[image] saved', file);
  return file;
}

// --- TODO 3: STORE (local JSON for now) ---
async function storeResult(customerId, result) {
  const file = `result_${customerId || 'test'}.json`;
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log('[store] wrote', file);
  // Production: write to a DB/KV keyed by customerId so the result page can load it.
}

// --- TODO 4: EMAIL (Resend) ---
async function deliverEmail(email, result, { keepsakePdf }) {
  if (!RESEND_API_KEY) { console.warn('[email] RESEND_API_KEY missing — skipping email'); return; }
  const reading = (result.sections.reading || result.sections.deepReport || '').replace(/\n/g, '<br>');
  const portrait = result.images[0];
  const attachments = [];
  if (portrait && fs.existsSync(portrait)) {
    attachments.push({ filename: 'your-soulmate.png', content: fs.readFileSync(portrait).toString('base64') });
  }
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;color:#2a1030">
    <h1 style="font-family:Georgia,serif">Your Soulmate Reading ✨</h1>
    <p style="line-height:1.7">${reading}</p>
    <p style="font-size:12px;color:#888">Your portrait is attached. For entertainment &amp; self-reflection only — not a prediction. Questions? ${SUPPORT_EMAIL}</p>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: email, subject: 'Your Soulmate Reading is inside ✨', html, attachments }),
  });
  if (!r.ok) throw new Error(`Resend email ${r.status}: ${await r.text()}`);
  console.log('[email] sent to', email);
}

/* ===============================================================
 * 7. Health + start (only when run directly, not when imported by the test)
 * =============================================================== */
app.get('/health', (_req, res) => res.send('ok'));
// Serve the checkout page from the same server, so one public URL does everything.
const path = require('path');
app.get('/', (_req, res) => res.redirect('/checkout'));
app.get('/checkout', (_req, res) => res.sendFile(path.join(__dirname, 'soulmate_checkout.html')));
if (require.main === module) {
  app.listen(PORT, () => console.log(`Soulmate server on :${PORT} (support ${SUPPORT_EMAIL})`));
}

module.exports = {
  verifyPaddleSignature, handleCompletedTransaction,
  buildReadingPrompt, buildPortraitPrompt, seedFrom,
  generateText, generateImage,
};
