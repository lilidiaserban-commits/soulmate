/**
 * SOULMATE, Payment webhook + AI generation backend
 * -------------------------------------------------------------
 * Node/Express. Receives Gumroad "sale" pings, reads the quiz
 * answers from url_params, runs the AI engine (reading + portrait
 * per `04`), then delivers the result and emails a copy.
 *
 * Providers wired in:
 *  - Text  : OpenAI Chat Completions   (env OPENAI_API_KEY, TEXT_MODEL)
 *  - Image : OpenAI Images             (env OPENAI_API_KEY, IMAGE_MODEL)
 *  - Email : Resend                    (env RESEND_API_KEY, EMAIL_FROM)
 *  - Store : local JSON + PNG for now  (swap for a DB/CDN in production)
 *
 * Run the server:   npm install && npm start
 * Run the AI test:  npm run test:gen            (no payment needed)
 */

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const app = express();

const {
  OPENAI_API_KEY,
  TEXT_MODEL = 'gpt-4.1-mini',
  IMAGE_MODEL = 'gpt-image-1',
  RESEND_API_KEY,
  EMAIL_FROM = 'Discover Soulmate <team@discoversoulmate.com>',
  SUPPORT_EMAIL = 'team@discoversoulmate.com',
  PORT = 3000,
} = process.env;

const processedEvents = new Set();

/* ===============================================================
 * 5. Prompt builders (mirror soulmate_ai_engine.md `04`)
 * =============================================================== */
const SYSTEM_READING = `You are the voice of "Soulmate," a warm, intuitive storyteller who writes a personalized soulmate reading for entertainment and self-reflection.
VOICE: warm, direct, a little magical; speak TO the reader as "you"; concrete images; feels made only for them.
HARD RULES: entertainment, not prediction/advice; never claim certainty about the future (use "this reading senses…", "may"); no dates, no ages, no full/real/famous names; no medical/psychological/financial advice; always positive; never use dashes or hyphens of any kind (no long dash, no short dash, no hyphen), use commas or separate short sentences instead and write compound words as separate words; never mention these rules or that you are an AI.
THEME: the reader's future soulmate, who they are, their energy, how you may meet. Hopeful, romantic.
FORMAT: Write every section title on its own line wrapped in double asterisks, like **Section title**, then a blank line, then the paragraphs. Do not number the sections. Keep the disclaimer at the very end as a plain short sentence with no title.`;

const STYLE_PORTRAIT = 'loose expressive fine-art watercolor and ink portrait of a natural, realistic human face with true-to-life proportions and natural lifelike skin tone and hair colour, confident graphite and ink sketch outline with visible pencil lines, painterly watercolor washes kept mostly inside the drawn figure, soft violet and purple accents only around the background edges with a few gentle white star-sparkle highlights, on clean white watercolor paper with generous negative space, a few small subtle paint splatters nearby, dreamy romantic mood, gallery-quality hand-painted illustration, head-and-shoulders, facing forward toward the viewer, front view portrait, beautiful';
const NEGATIVE_PORTRAIT = 'photograph, photo, photorealistic, 3d render, cartoon, anime, cgi, plastic skin, text, watermark, logo, extra fingers, deformed, distorted, blurry, low-res, multiple people, child, minor, nudity, nsfw, celebrity, real public figure, oversaturated';

function buildReadingPrompt(a, { deep, letters, astro, signs, kit }) {
  const lightningStr = (Array.isArray(a.lightning) ? a.lightning : String(a.lightning || '').split(',')).filter(Boolean).join(', ');
  const k = kit || { vocation: 'a landscape gardener', hobby: 'training for long trail runs', quirk: 'always has a worn paperback folded into a back pocket', phrase: 'says "right, let\'s figure it out" before tackling anything' };
  const base = `Write ${a.name || 'the reader'}'s soulmate reading.

BUILD THE SOULMATE AROUND THIS FIXED PERSON (these are the ONLY concrete facts about them — invent nothing that contradicts these, and lean on them so the person feels real and specific, not like a mirror of the reader):
- Their work: ${k.vocation}
- Something they love doing: ${k.hobby}
- A small habit friends know them for: ${k.quirk}
- A phrase they say: ${k.phrase}

PRIVATE INSPIRATION — feel these only in your own mind to set a faint direction. They must NEVER appear in the reading in any recognizable form:
- They hope to meet: ${a.meet} (this only sets whether the soulmate is a man or a woman)
- Reader's age band: ${a.age} (loosely informs the soulmate's age)
- A private hint of their energy: ${a.energy}
- What the reader quietly values: ${a.value}
- Faint personality texture: ${lightningStr}

ABSOLUTE RULES (critical — the reader must never recognise their own quiz answers in the text):
- NEVER name or even hint at a colour when describing the person, their home, or their style (no "red", "deep red accents", "soft greens", etc.).
- NEVER make a time of day a defining trait (no "early mornings", "before dawn", "a night owl").
- NEVER mention coffee, tea or any drink anywhere in the reading.
- NEVER reuse the reader's own descriptor words for energy or values — do not write words like "calm", "grounded", "adventurous", "warm", "mysterious", "loyal" or "loyalty". Describe the person entirely in your own fresh wording.
- NEVER quote, list, restate or mirror the reader's answers. If a reader could read a sentence and spot their own quiz choice in it, rewrite that sentence.
- Build every section from the FIXED PERSON above (their work, what they love doing, their habit, their phrase) and expand outward with fresh, believable detail that fits that person. Never repeat a trait or image, and never fall back on the reader's own answers.
- Warm, specific and grounded; no vague filler, no over-poetic clichés.

Sections in order, each with its own title: Intro, Who they are, How you'll meet, Little signs to watch for, A note for you, Disclaimer.
"How you'll meet" describes ONLY the setting and circumstances of how you might come together (a place, a situation, a shared context). Do NOT mention any season, month or time of year here — the season belongs only to the extended reading, so mentioning it here would contradict it.
"Who they are" must be a vivid, specific portrait built on the FIXED PERSON above — their work (${k.vocation}), what they love doing (${k.hobby}), their habit and their phrase — plus how they spend an ordinary day and where they feel at home. Tangible things a friend would tell you, NOT abstract "essence / energy / vibe" language and NOT the reader's preferences restated.
"Little signs to watch for" = present exactly these three as gentle playful winks to notice in the coming weeks, and use EXACTLY these, do not invent others: the colour ${signs ? signs.color : 'soft blue'}, the symbol ${signs ? signs.symbol : 'a feather'}, and the number ${signs ? signs.number : 12}. Weave them warmly into a short paragraph, light and for fun, never a certainty. This is the ONLY signs section — do not add a second one. Do NOT mention coffee, tea, or any drink here.
Disclaimer must read exactly: "This reading is a creative interpretation, made just for you, for reflection and fun, not prediction."
Length 380 to 480 words.`;
  const deepExtra = `
ALSO add these sections before the disclaimer, each adding genuinely NEW material (never repeating earlier sections or the same trait):
- The season you may meet: frame as a SEASON / life-energy window, never a date.
- Red flags to watch for: 2 to 3 gentle, VARIED "this may not be your person if…" signals — each about a DIFFERENT thing, not all about one trait.
- Your compatibility map: "Where you'll click" + "Where you'll grow", concrete and specific.
- A little clue about their name: playfully hint the first letter of their name seems to shimmer, it may be one of these: ${(letters && letters.length ? letters.join(', ') : 'A, M, L')}. A fun wink with a few possible letters, warm and light, never a certainty.
- A cosmic clue just for fun: open with one light playful line, then include these three lines exactly as written, each on its own line:
Possible zodiac sign: ${(astro && astro.sun) ? astro.sun.join(', ') : 'Leo, Libra'}
Possible Moon sign: ${(astro && astro.moon) ? astro.moon.join(', ') : 'Capricorn, Libra'}
Possible Rising sign: ${(astro && astro.rising) ? astro.rising.join(', ') : 'Cancer, Aries'}
Keep it a wink, never a certainty.
- How you might recognize them: build this from the FIXED PERSON's habit ("${k.quirk}") and their phrase (${k.phrase}) — one small everyday moment that would make the reader think "that's them". Something they naturally do or say in their OWN life, NOT spoken to the reader and NOT at the moment you meet. NEVER mention coffee, tea or any drink. One or two concrete, specific sentences, warm but not romantic.
Add +500 to 700 words.`;
  return { system: SYSTEM_READING, user: deep ? base + deepExtra : base };
}

function buildUpgradePrompt(a, { letters, astro, kit }) {
  const k = kit || { vocation: 'a landscape gardener', hobby: 'training for long trail runs', quirk: 'always has a worn paperback folded into a back pocket', phrase: 'says "right, let\'s figure it out" before tackling anything' };
  const persona = `THE SAME FIXED PERSON from the base reading (build everything on these, invent nothing that contradicts them):
- Their work: ${k.vocation}
- Something they love doing: ${k.hobby}
- A habit friends know them for: ${k.quirk}
- A phrase they say: ${k.phrase}`;
  const signals = `PRIVATE INSPIRATION (must NEVER appear in the text in any recognizable form):
- They hope to meet: ${a.meet} (only sets whether the soulmate is a man or a woman)
- Reader's age band: ${a.age}
- A private hint of their energy: ${a.energy}
- What the reader quietly values: ${a.value}
- Faint personality texture: ${(Array.isArray(a.lightning) ? a.lightning : String(a.lightning || '').split(',')).filter(Boolean).join(', ')}`;
  const user = `${a.name ? a.name + ' ' : 'The reader '}already received their base soulmate reading and their first portrait. Now write ONLY the deeper, extended premium layers they just unlocked. Do NOT repeat the base reading and do NOT reintroduce their soulmate from scratch. Open with one short warm line saying this is the deeper layer they unlocked.
ABSOLUTE RULES (the reader must never recognise their own quiz answers): NEVER name or hint at a colour. NEVER make a time of day a defining trait. NEVER reuse the reader's own energy/value words (no "calm", "grounded", "adventurous", "warm", "mysterious", "loyal", "loyalty"). NEVER mention coffee, tea or any drink. NEVER quote, list, restate or mirror the reader's answers. Build every section on the FIXED PERSON below; give each section genuinely NEW material, never the same trait twice.
${persona}
${signals}
Sections in order, each with its own title:
- The season you may meet: frame as a SEASON or life energy window, never a date.
- Red flags to watch for: 2 to 3 VARIED "this may not be your person if…" signals — each about a DIFFERENT thing — that clearly tell the reader when someone is NOT their match. Supportive and caring in tone, but unmistakably about warning signs.
- Your compatibility map: "Where you'll click" and "Where you'll grow".
- A little clue about their name: playfully hint the first letter of their name may be one of these: ${(letters && letters.length ? letters.join(', ') : 'A, M, L')}. A warm wink with a few possible letters, never a certainty.
- A cosmic clue just for fun: open with one light playful line, then include these three lines exactly as written, each on its own line:
Possible zodiac sign: ${(astro && astro.sun) ? astro.sun.join(', ') : 'Leo, Libra'}
Possible Moon sign: ${(astro && astro.moon) ? astro.moon.join(', ') : 'Capricorn, Libra'}
Possible Rising sign: ${(astro && astro.rising) ? astro.rising.join(', ') : 'Cancer, Aries'}
Keep it a wink, never a certainty.
- How you might recognize them: build this from the FIXED PERSON's habit ("${k.quirk}") and their phrase (${k.phrase}) — one small everyday moment that would make the reader think "that's them". Something they naturally do or say in their OWN life, NOT spoken to the reader and NOT at the moment you meet. NEVER mention coffee, tea or any drink. One or two concrete, specific sentences, warm but not romantic.
Disclaimer must read exactly: "This reading is a creative interpretation, made just for you, for reflection and fun, not prediction."
Length 500 to 700 words.`;
  return { system: SYSTEM_READING, user };
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

function nameLetters(seed, n) {
  const A = 'ABCDEFGHIJKLMNPRSTV';
  const out = [];
  let x = (seed >>> 0) || 1;
  while (out.length < n && out.length < A.length) {
    const c = A[x % A.length];
    if (!out.includes(c)) out.push(c);
    x = (x * 1103515245 + 12345) >>> 0;
  }
  return out;
}

const ZODIAC = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
function astroHints(seed) {
  const pick2 = (off) => {
    let x = ((seed >>> 0) + off * 2654435761) >>> 0;
    const a = ZODIAC[x % 12];
    x = (x * 1103515245 + 12345) >>> 0;
    let b = ZODIAC[x % 12];
    if (b === a) b = ZODIAC[(x + 5) % 12];
    return [a, b];
  };
  return { sun: pick2(1), moon: pick2(2), rising: pick2(3) };
}

function soulJourney(seed) {
  const lives = 3 + ((seed >>> 0) % 40);
  const age = lives < 12 ? 'a younger soul' : lives < 25 ? 'a maturing soul' : 'an old soul';
  return { lives, age };
}

const SIGN_COLORS = ['emerald green','sky blue','warm amber','dusty rose','soft lavender','golden yellow','deep teal','coral','burnt orange','pale mint','plum purple','sunflower gold','sea green','powder blue','soft peach','silver grey'];
const SIGN_SYMBOLS = ['a feather','a small brass key','a butterfly','a crescent moon','a seashell','a four leaf clover','a paper crane','a single white flower','a compass','a shooting star','a ladybug','a small lighthouse','a dandelion','a heart shaped stone','a swallow in flight','a lit candle'];
const SIGN_NUMBERS = [3, 4, 5, 6, 8, 9, 11, 12, 13, 16, 18, 21, 22, 24, 27, 33];
function signHints(seed) {
  const pick = (arr, off) => arr[(((seed >>> 0) + off * 2654435761) >>> 0) % arr.length];
  return { color: pick(SIGN_COLORS, 7), symbol: pick(SIGN_SYMBOLS, 13), number: pick(SIGN_NUMBERS, 19) };
}

// A fixed, seeded "kit" of concrete invented details so the reading is built
// around a real independent person — NOT paraphrased from the reader's quiz
// answers. Nothing here references a colour, a time of day, or a drink.
const KIT_VOCATIONS = ['a carpenter who restores old furniture','a paediatric nurse','a high-school geography teacher','a landscape gardener','a sound engineer for live gigs','someone who runs a small neighbourhood bakery','a marine biologist','a bookshop manager','a physiotherapist','an architect who still sketches by hand','a ceramics maker','a wildlife photographer','a chef at a tiny bistro','someone who runs a bicycle-repair shop','a primary-school music teacher','a developer who builds small indie games'];
const KIT_HOBBIES = ['climbing at the local crag on weekends','slowly restoring a vintage motorbike','growing tomatoes and herbs on their balcony','playing bass in a covers band','training for long trail runs','teaching themselves the violin','sea kayaking whenever they can','hunting through crates for old vinyl','woodworking in a cramped home workshop','baking sourdough that never quite behaves','birdwatching on quiet trails','painting small watercolours of places they visit','bouldering at an indoor gym','patching up an old wooden sailboat','learning to cook proper Thai food','volunteering at an animal shelter'];
const KIT_QUIRKS = ['always has a worn paperback folded into a back pocket','hums half-remembered film scores while they concentrate','keeps a running list of gloriously bad puns','can name almost any bird by its call alone','doodles tiny maps on the corner of napkins','somehow remembers everyone\'s half-birthday','takes the stairs two at a time out of habit','keeps a jar of coins from every place they\'ve been','quietly narrates what other people\'s dogs are thinking','fixes squeaky hinges in every house they visit','collects postcards they never get around to sending','always has a spare charger ready for a stranger'];
const KIT_PHRASES = ['says "right, let\'s figure it out" before tackling anything','ends every story with "and that\'s the whole saga"','greets people with a warm "there you are"','calls small victories "a proper result"','waves off worry with "one thing at a time"','describes anything they love as "quietly brilliant"','answers "how are you?" with a grin and "still standing"','calls their friends "you legend" and means it'];
function personaKit(seed) {
  const pick = (arr, off) => arr[(((seed >>> 0) + off * 2654435761) >>> 0) % arr.length];
  return {
    vocation: pick(KIT_VOCATIONS, 3),
    hobby: pick(KIT_HOBBIES, 11),
    quirk: pick(KIT_QUIRKS, 23),
    phrase: pick(KIT_PHRASES, 31),
  };
}

/* ===============================================================
 * 6. Providers (the 4 TODOs, now wired)
 * =============================================================== */

// --- TEXT (OpenAI Chat Completions) ---
async function generateText({ system, user }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing, check your .env file');
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

// --- IMAGE (OpenAI Images) ---
async function generateImage({ prompt, negative, aspect }, { seed, hd }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing, check your .env file');
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
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('[image] saved', file);
  return file;
}

// --- STORE (local JSON for now) ---
async function storeResult(customerId, result) {
  const file = `result_${customerId || 'test'}.json`;
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log('[store] wrote', file);
}

// --- EMAIL (Resend) ---
async function deliverEmail(email, result, { keepsakePdf }) {
  if (!RESEND_API_KEY) { console.warn('[email] RESEND_API_KEY missing, skipping email'); return; }
  const reading = (result.sections.reading || result.sections.deepReport || '').replace(/\n/g, '<br>');
  const portrait = result.images[0];
  const attachments = [];
  if (portrait && fs.existsSync(portrait)) {
    attachments.push({ filename: 'your-soulmate.png', content: fs.readFileSync(portrait).toString('base64') });
  }
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;color:#2a1030">
    <h1 style="font-family:Georgia,serif">Your Soulmate Reading ✨</h1>
    <p style="line-height:1.7">${reading}</p>
    <p style="font-size:12px;color:#888">Your portrait is attached. For entertainment &amp; self-reflection only, not a prediction. Questions? ${SUPPORT_EMAIL}</p>
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
 * 7. Health + pages
 * =============================================================== */
app.get('/health', (_req, res) => res.send('ok'));
const path = require('path');
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'soulmate_home.html')));
app.get(['/soulmate', '/checkout'], (_req, res) => res.sendFile(path.join(__dirname, 'soulmate_funnel.html')));

// Result page fetches the generated reading + portrait by transaction id.
app.get('/result', (req, res) => {
  const tx = String(req.query.tx || '');
  const file = `result_${tx}.json`;
  if (tx && fs.existsSync(file)) return res.type('application/json').send(fs.readFileSync(file));
  res.json({ status: 'pending' });
});

// Serve a generated portrait image by filename (portrait_*.png only).
app.get('/portrait/:file', (req, res) => {
  const file = req.params.file;
  if (!/^portrait_[A-Za-z0-9_]+\.png$/.test(file)) return res.status(400).end();
  const full = path.join(__dirname, file);
  if (fs.existsSync(full)) return res.type('png').send(fs.readFileSync(full));
  res.status(404).end();
});

/* ===============================================================
 * 8. Legal pages (Terms, Privacy, Refund)
 * =============================================================== */
const LEGAL_COMPANY = 'VIRALMOSAIC IMPACT SRL';
const LEGAL_ADDRESS = 'Strada Ghiocului 24, 051404, Bucharest, Romania';
const CONTACT_EMAIL = 'team@discoversoulmate.com';
const LEGAL_UPDATED = '28 July 2026';

function legalPage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Soulmate</title>
<style>
:root{color-scheme:light}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Georgia,serif;max-width:720px;margin:0 auto;padding:48px 22px 80px;color:#241033;line-height:1.7;background:#faf7fc}
a{color:#7a3f9d}
h1{font-size:28px;margin:0 0 4px}
h2{font-size:18px;margin:32px 0 8px}
.meta{color:#8a7a95;font-size:13px;margin-bottom:28px}
.back{display:inline-block;margin-bottom:24px;font-size:14px}
.box{background:#fff;border:1px solid #eee3f2;border-radius:14px;padding:22px 26px}
p,li{font-size:15px}
.fine{color:#8a7a95;font-size:13px;margin-top:36px;border-top:1px solid #eee3f2;padding-top:16px}
</style></head><body>
<a class="back" href="/">← Back to Soulmate</a>
<div class="box">
<h1>${title}</h1>
<div class="meta">Last updated: ${LEGAL_UPDATED}</div>
${bodyHtml}
<div class="fine">${LEGAL_COMPANY} · ${LEGAL_ADDRESS} · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a><br>
Payments are processed by Gumroad, our Merchant of Record.</div>
</div></body></html>`;
}

app.get('/terms', (_req, res) => res.type('html').send(legalPage('Terms &amp; Conditions', `
<p>These Terms govern your use of the Soulmate website and the personalized reading and portrait service (the "Service"), operated by ${LEGAL_COMPANY}. By using the Service or making a purchase, you agree to these Terms.</p>
<h2>1. What the Service is</h2>
<p>Soulmate creates an AI-generated, personalized reading and portrait based on the answers you provide. It is offered <strong>for entertainment and self-reflection only</strong>. It is not a prediction, psychic service, or advice of any kind, and it is not medical, psychological, legal, or financial guidance. We make no claim that any part of a reading is accurate or will come true.</p>
<h2>2. Eligibility</h2>
<p>You must be 18 or older to use the Service.</p>
<h2>3. Purchases &amp; payment</h2>
<p>The Service is sold as a one-time purchase, plus any optional add-ons you choose. Prices are shown at checkout. Payments are processed by <strong>Gumroad</strong>, which acts as our Merchant of Record and is the seller of record for your order. Your receipt and invoice are issued by Gumroad.</p>
<h2>4. Delivery</h2>
<p>Your reading and portrait are digital products, generated after your purchase and delivered by email. Generation may take a few moments.</p>
<h2>5. Your content &amp; intellectual property</h2>
<p>We and our licensors own the Service and its underlying materials. You receive a personal, non-commercial licence to the reading and portrait generated for you. Please do not resell or present the content as a professional prediction or diagnosis.</p>
<h2>6. Acceptable use</h2>
<p>Do not misuse the Service, attempt to disrupt it, or submit unlawful content.</p>
<h2>7. Disclaimers &amp; limitation of liability</h2>
<p>The Service is provided "as is", for entertainment. To the fullest extent permitted by law, we are not liable for any decision you make based on a reading, or for indirect or consequential loss. Nothing in these Terms limits rights that cannot be excluded under applicable consumer law.</p>
<h2>8. Changes</h2>
<p>We may update these Terms from time to time. The current version is always available on this page.</p>
<h2>9. Governing law</h2>
<p>These Terms are governed by the laws of Romania. Mandatory consumer-protection rights in your country of residence still apply.</p>
<h2>10. Contact</h2>
<p>Questions? Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`)));

app.get('/privacy', (_req, res) => res.type('html').send(legalPage('Privacy Policy', `
<p>This Privacy Policy explains how ${LEGAL_COMPANY} ("we") handles your personal data when you use the Soulmate service. We are the data controller.</p>
<h2>1. Data we collect</h2>
<p>We collect: (a) the answers you give in the quiz; (b) your email address, so we can send you your result; and (c) purchase information, which is handled by our payment provider, Gumroad. We do not ask for or store your card details, Gumroad handles payment securely.</p>
<h2>2. Why we use it &amp; legal basis</h2>
<p>We use your data to create and deliver your reading and portrait and to email it to you, this is necessary to perform the service you purchased (contract). We keep data collection to the minimum needed for this.</p>
<h2>3. Who we share it with (processors)</h2>
<p>We use a small number of trusted providers to run the Service: <strong>OpenAI</strong> (to generate the reading and portrait), <strong>Resend</strong> (to email your result), and <strong>Gumroad</strong> (to process payment as Merchant of Record). They process data on our behalf under their own security terms. <strong>We never sell your personal data.</strong></p>
<h2>4. International transfers</h2>
<p>Some providers may process data outside the EU/EEA. Where that happens, appropriate safeguards (such as Standard Contractual Clauses) apply.</p>
<h2>5. Retention</h2>
<p>We keep your data only as long as needed to deliver your result and meet legal or accounting obligations, then delete or anonymize it.</p>
<h2>6. Your rights (GDPR)</h2>
<p>You have the right to access, correct, delete, or export your data, and to object to or restrict certain processing. To exercise any right, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. You also have the right to complain to the Romanian Data Protection Authority (ANSPDCP).</p>
<h2>7. Cookies</h2>
<p>We use only the minimal cookies/technology needed for the site to work. We do not use them to build advertising profiles of you.</p>
<h2>8. Contact</h2>
<p>${LEGAL_COMPANY}, ${LEGAL_ADDRESS}, <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`)));

app.get('/refund', (_req, res) => res.type('html').send(legalPage('Refund &amp; Cancellation Policy', `
<p>This policy explains refunds for the Soulmate service, sold by ${LEGAL_COMPANY} through Gumroad (our Merchant of Record).</p>
<h2>1. Digital product, delivered on demand</h2>
<p>Your reading and portrait are personalized digital content, generated specifically for you and delivered immediately after purchase.</p>
<h2>2. Right of withdrawal</h2>
<p>Under EU consumer law you normally have 14 days to withdraw from an online purchase. For digital content that is supplied immediately, this right ends once delivery begins, and by starting your reading you ask us to begin right away and acknowledge you lose the 14-day withdrawal right for that content. This is standard for instant digital goods.</p>
<h2>3. We still want you happy</h2>
<p>If something went wrong, you didn't receive your result, or there was a technical problem, contact us within 14 days at <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we'll make it right or issue a refund.</p>
<h2>4. How refunds are processed</h2>
<p>Because Gumroad is our Merchant of Record, refunds are issued through Gumroad back to your original payment method. You can contact us or reply to your Gumroad receipt to request one.</p>
<h2>5. Contact</h2>
<p>${LEGAL_COMPANY}, <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`)));

app.get('/contact-us', (_req, res) => res.type('html').send(legalPage('Contact Us', `
<p>We'd love to hear from you. For any question about your reading, your order, a refund, or your data, email us and we'll reply as soon as we can.</p>
<h2>Email</h2>
<p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
<h2>Who we are</h2>
<p>${LEGAL_COMPANY}<br>${LEGAL_ADDRESS}</p>
<p>Soulmate is an entertainment and self-reflection experience. Payments are handled by Gumroad, our Merchant of Record.</p>
`)));

/* ---- Pricing page (public prices) ---- */
app.get('/pricing', (_req, res) => res.type('html').send(legalPage('Pricing', `
<p>All purchases are one-time digital payments. Prices are also shown at checkout, where payment is processed securely by Gumroad, our Merchant of Record. Any applicable VAT is added at checkout depending on your country.</p>
<h2>Soulmate Reading, €16.99</h2>
<p>Your personalized soulmate reading plus a portrait made just for you, delivered instantly by email. One-time payment.</p>
<h2>Soulmate Premium, €26.99</h2>
<p>An extended reading with the season you may meet, compatibility map, red flags to watch for, and three portraits of your soulmate.</p>
<h2>Extended Soulmate upgrade, €10</h2>
<p>Already have your base Soulmate reading? Unlock the extended version for the difference: the season you may meet, compatibility map, gentle signs, a clue about their name and stars, and two more portraits.</p>
<h2>Love Compatibility (extended), €16.99</h2>
<p>The full compatibility reading for two people: where you click, where you grow, your connection type, and what your bond is really made of.</p>
<h2>Tarot, Past Life &amp; Love Archetype (extended), €14.99 each</h2>
<p>The full, in-depth version of each reading, delivered instantly by email. Each is a separate one-time purchase.</p>
<p>These are digital products offered for entertainment and self-reflection only, not predictions or advice.</p>
`)));

/* ---- Free readings (no payment needed) ---- */
app.get('/love-archetype', (_req, res) => res.sendFile(path.join(__dirname, 'reading_love_archetype.html')));
app.get('/past-life', (_req, res) => res.sendFile(path.join(__dirname, 'reading_past_life.html')));
app.get('/tarot', (_req, res) => res.sendFile(path.join(__dirname, 'reading_tarot.html')));
app.get('/compatibility', (_req, res) => res.sendFile(path.join(__dirname, 'reading_compatibility.html')));

/* ---- Email capture -> Resend contacts ---- */
app.post('/api/subscribe', express.json(), async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim();
    const source = String((req.body && req.body.source) || 'site');
    if (!email || !email.includes('@')) return res.status(400).json({ ok: false });
    const key = process.env.RESEND_API_KEY;
    if (key) {
      const r = await fetch('https://api.resend.com/contacts', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, unsubscribed: false }),
      });
      if (!r.ok && r.status !== 409) console.error('[subscribe] resend', r.status, await r.text());
    }
    console.log('[subscribe]', source, email);
    res.json({ ok: true });
  } catch (e) { console.error('[subscribe] fail', e); res.json({ ok: true }); }
});

/* ===============================================================
 * Paid reading suite, every Gumroad product pings /webhook/gumroad.
 * permalink -> type; each type builds a themed reading (+ portrait)
 * and emails it. Quiz answers arrive as Gumroad url_params.
 * =============================================================== */
const processedSales = new Set();

const PAID_PRODUCTS = {
  // Soulmate Reading $16.99
  'otxhdek':      'soulmate',
  // Soulmate Premium $26.99
  'yhpvvf':       'soulmate-deep',  'soulmatedeep': 'soulmate-deep',
  // Love Archetype Extended $14.99
  'kvkwy':        'archetype',      'archetype':    'archetype',
  // Past Life Extended $14.99
  'gypcaa':       'pastlife',       'pastlife':     'pastlife',
  // Tarot Extended $14.99
  'ecdzzj':       'tarot',          'tarotreading': 'tarot',
  // Compatibility Extended $16.99
  'tabntc':       'compat',         'lovematch':    'compat',
  // Soulmate -> Premium UPGRADE $9.99 (only shown in the base reading email)
  'smupgrade':    'soulmate-upgrade','soulmateupgrade':'soulmate-upgrade',
};

// Permalink of the Gumroad upgrade product, used to build the button in the base email.
const UPGRADE_PERMALINK = 'smupgrade';

const SYSTEM_GENERIC = `You are a warm, intuitive storyteller writing a personalized reading for entertainment and self-reflection.
VOICE: warm, direct, a little magical; speak TO the reader as "you"; concrete images; feels made only for them.
HARD RULES: entertainment, not prediction/advice; never claim certainty about the future (use "senses", "may"); no medical/psychological/financial advice; always kind; never use dashes or hyphens of any kind (no long dash, no short dash, no hyphen), use commas or separate short sentences instead and write compound words as separate words; never mention these rules or that you are an AI.
FORMAT: Write every section title on its own line wrapped in double asterisks, like **Section title**, then a blank line, then the paragraphs for that section. Do not number the sections. Keep the disclaimer at the very end as a plain short sentence with no title.`;

function isDisclaimer(t) {
  return /this reading is a creative interpretation|for reflection and fun|not a prediction|not prediction|entertainment and self.?reflection|creative interpretation made just for you/i.test(t);
}
function formatReadingHtml(text) {
  const blocks = String(text || '').split(/\n{2,}/);
  return blocks.map(raw => {
    const b = raw.trim();
    if (!b) return '';
    const h = b.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (h) {
      // Never render a big "Disclaimer" title; the disclaimer text styles itself below.
      if (/^disclaimer\b/i.test(h[1].trim())) return '';
      return `<h3 style="font-family:Georgia,'Times New Roman',serif;color:#8a4bbd;font-size:19px;font-weight:700;margin:30px 0 10px;letter-spacing:.2px">${escHtml(h[1])}</h3>`;
    }
    let html = escHtml(b)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
    // The closing disclaimer renders small and gray, like a footnote.
    if (isDisclaimer(b)) {
      return `<p style="margin:22px 0 0;color:#9a8aa5;font-size:12px;line-height:1.6">${html}</p>`;
    }
    return `<p style="margin:0 0 15px;color:#3d2d49;font-size:16px;line-height:1.78">${html}</p>`;
  }).join('');
}

async function sendReadingEmail(email, subject, heading, bodyText, portraitFile, opts = {}) {
  if (!RESEND_API_KEY) { console.warn('[email] RESEND_API_KEY missing, skipping'); return; }
  const files = (Array.isArray(portraitFile) ? portraitFile : [portraitFile]).filter(f => f && fs.existsSync(f));
  const attachments = [];
  let portraitBlock = '';
  if (files.length) {
    files.forEach((f, i) => {
      attachments.push({ filename: `your-portrait-${i + 1}.png`, content: fs.readFileSync(f).toString('base64'), content_id: `portrait${i}` });
    });
    let grid;
    if (files.length === 1) {
      grid = `<img src="cid:portrait0" width="290" alt="Your portrait" style="width:290px;max-width:78%;border-radius:16px;border:3px solid rgba(244,199,138,.55);box-shadow:0 12px 34px rgba(0,0,0,.4);display:block;margin:0 auto">`;
    } else {
      // two or three portraits, equal size, side by side
      const w = files.length >= 3 ? 168 : 236;
      const mw = files.length >= 3 ? '30%' : '45%';
      grid = `<div style="line-height:0;font-size:0;text-align:center">` + files.map((_, i) =>
        `<img src="cid:portrait${i}" width="${w}" alt="Portrait" style="width:${w}px;max-width:${mw};border-radius:14px;border:3px solid rgba(244,199,138,.55);box-shadow:0 10px 28px rgba(0,0,0,.38);margin:6px;display:inline-block;vertical-align:top">`
      ).join('') + `</div>`;
    }
    const nWord = { 2: 'two', 3: 'three' }[files.length] || '';
    const caption = files.length > 1 ? `${nWord} portraits of your soulmate, created just for you` : 'created just for you';
    portraitBlock = `
      <tr><td style="background:linear-gradient(160deg,#2e1640,#4a1f47);padding:28px 26px;text-align:center">
        ${grid}
        <div style="font-family:Georgia,serif;color:#e7dcf1;font-size:13px;font-style:italic;margin-top:15px">${caption}</div>
      </td></tr>`;
  }
  let upgradeBlock = '';
  if (opts.upgradeUrl) {
    upgradeBlock = `
      <div style="margin:34px 0 6px;background:linear-gradient(160deg,#2e1640,#5a2a7a);border-radius:18px;padding:30px 26px;text-align:center;box-shadow:0 12px 34px rgba(90,40,120,.32)">
        <div style="display:inline-block;background:rgba(244,199,138,.18);color:#f4c78a;font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:6px 15px;border-radius:999px;margin-bottom:15px">✦ Go deeper</div>
        <div style="font-family:Georgia,'Times New Roman',serif;color:#ffffff;font-size:23px;line-height:1.3;margin-bottom:12px">Unlock your Extended Soulmate reading</div>
        <p style="color:#e7dcf1;font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.7;margin:0 auto 24px;max-width:420px">The season you may meet, red flags to watch for, your compatibility map, a clue about their name and their stars, and <b>two more portraits</b> of your soulmate.</p>
        <a href="${opts.upgradeUrl}" style="display:inline-block;background:linear-gradient(135deg,#f7d9a6,#e7a86b);color:#3a1d2e;font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-weight:700;font-size:17px;text-decoration:none;padding:17px 42px;border-radius:999px;box-shadow:0 8px 22px rgba(0,0,0,.3)">Unlock the extended version →</a>
      </div>`;
  }
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f1eaf7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1eaf7;margin:0;padding:0">
  <tr><td align="center" style="padding:26px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:22px;overflow:hidden;box-shadow:0 10px 40px rgba(90,40,120,.14)">
      <tr><td style="background:linear-gradient(135deg,#2e1640,#5a2a7a 55%,#7a3f9d);padding:36px 30px;text-align:center">
        <div style="font-family:Georgia,'Times New Roman',serif;color:#f4c78a;letter-spacing:3px;text-transform:uppercase;font-size:12px">✦ Discover Soulmate ✦</div>
        <div style="font-family:Georgia,serif;color:#ffffff;font-size:26px;line-height:1.25;margin-top:12px">${escHtml(heading)}</div>
      </td></tr>
      ${portraitBlock}
      <tr><td style="padding:32px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
        ${formatReadingHtml(bodyText)}
        ${upgradeBlock}
      </td></tr>
      <tr><td style="background:#faf7fc;padding:24px 30px;text-align:center;border-top:1px solid #eee3f2">
        <div style="font-family:Georgia,serif;color:#7a3f9d;font-size:16px">Discover Soulmate<span style="color:#e7b6c9">.</span></div>
        <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;color:#9a8aa5;font-size:12px;margin-top:9px;line-height:1.6">For entertainment and self reflection only. A creative interpretation made just for you, not a prediction or advice.<br>Questions? ${SUPPORT_EMAIL}</div>
      </td></tr>
    </table>
    <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;color:#b3a6c0;font-size:11px;margin-top:16px">© 2026 Discover Soulmate</div>
  </td></tr></table></body></html>`;
  // Plain text version (helps inbox placement: Gmail weighs a real text/plain part).
  const plain = String(bodyText || '').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim()
    + (files.length ? `\n\nYour portrait${files.length > 1 ? 's are' : ' is'} attached to this email.` : '')
    + (opts.upgradeUrl ? `\n\nP.S. If you would like to go deeper, you can read the extended version here: ${opts.upgradeUrl}` : '')
    + `\n\nDiscover Soulmate. For entertainment and self reflection only, not a prediction or advice. Questions? ${SUPPORT_EMAIL}`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: email, subject, html, text: plain, attachments }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  console.log('[email] sent to', email, '·', subject);
}

async function themedPortrait(promptCore, seed) {
  return generateImage({ prompt: `${promptCore}, ${STYLE_PORTRAIT}`, negative: NEGATIVE_PORTRAIT, aspect: '4:5' }, { seed, hd: true });
}

function noDashes(s) {
  return String(s == null ? '' : s)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/ -+ /g, ', ')
    .replace(/(\p{L})-(\p{L})/gu, '$1 $2')
    .replace(/-/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ');
}

async function generateForType(type, p, email, saleId, opts = {}) {
  const media = !opts.textOnly;
  const seed = seedFrom(saleId || email || 'x');
  const focus = String(p.focus || '').trim().slice(0, 400);
  const focusLine = focus ? ` The person especially wants this reading to speak to: "${focus}". Address that directly and warmly within the reading.` : '';
  let subject, heading, text, portrait = null, emailOpts = {};

  if (type === 'soulmate' || type === 'soulmate-deep') {
    const a = { name:p.name||'', meet:p.meet||'', age:p.age||'', energy:p.energy||'', look:p.look||'', value:p.value||'', lightning:p.lightning||'' };
    const deep = type === 'soulmate-deep';
    const letters = nameLetters(seed, deep ? 4 : 3);
    const astro = deep ? astroHints(seed) : null;
    const signs = signHints(seed);
    const kit = personaKit(seed);
    const smPrompt = buildReadingPrompt(a, { deep, letters, astro, signs, kit });
    if (focus && smPrompt && smPrompt.user) smPrompt.user += `\n\nThe person especially asked this reading to speak to: "${focus}". Address it warmly.`;
    text = await generateText(smPrompt);
    if (media) {
      if (deep) {
        const poses = [
          'front-facing, looking softly toward the viewer with a gentle smile, wearing a cozy cream knit sweater',
          'a three-quarter side view, gazing thoughtfully away, wearing a casual open collared button-up shirt in a soft colour',
          'a relaxed candid moment with a warm natural laugh, wearing a light denim jacket over a simple tee'
        ];
        portrait = [];
        for (let i = 0; i < poses.length; i++) {
          portrait.push(await generateImage(buildPortraitPrompt(a, poses[i]), { seed: seed + i, hd: true }));
        }
      } else {
        portrait = await generateImage(buildPortraitPrompt(a, 'front-facing, looking softly toward the viewer with a gentle smile, wearing a cozy cream knit sweater'), { seed, hd: false });
      }
    }
    subject = `${a.name ? a.name + ', your' : 'Your'} ${deep ? 'Premium Soulmate reading' : 'Soulmate reading'} is inside`;
    heading = deep ? 'Your Premium Soulmate Reading' : 'Your Soulmate Reading';
    // Base buyers get an "upgrade to Premium" button in their email. It carries their
    // answers plus the base sale id, so the upgrade reuses the same seed (letters, astro, faces).
    if (!deep) {
      const up = new URLSearchParams({
        ptype: 'soulmate-upgrade', baseid: String(saleId || ''),
        name: a.name, meet: a.meet, age: a.age, energy: a.energy,
        look: a.look, value: a.value,
        lightning: Array.isArray(a.lightning) ? a.lightning.join(',') : String(a.lightning || ''),
        email: String(email || ''),
      });
      emailOpts.upgradeUrl = `https://discoversoulmate.gumroad.com/l/${UPGRADE_PERMALINK}?wanted=true&` + up.toString();
    }
  }
  else if (type === 'soulmate-upgrade') {
    // The customer already has their base reading and first portrait. Deliver only the
    // deeper premium layers plus two NEW portraits (same person, new moments) = three total.
    const a = { name:p.name||'', meet:p.meet||'', age:p.age||'', energy:p.energy||'', look:p.look||'', value:p.value||'', lightning:p.lightning||'' };
    const baseSeed = seedFrom(p.baseid || saleId || email || 'x');
    const letters = nameLetters(baseSeed, 4);
    const astro = astroHints(baseSeed);
    const kit = personaKit(baseSeed);
    const upPrompt = buildUpgradePrompt(a, { letters, astro, kit });
    if (focus) upPrompt.user += `\n\nThe person especially asked this reading to speak to: "${focus}". Address it warmly.`;
    text = await generateText(upPrompt);
    if (media) {
      const poses = [
        'a three-quarter side view, gazing thoughtfully away, wearing a casual open collared button-up shirt in a soft colour',
        'a relaxed candid moment with a warm natural laugh, wearing a light denim jacket over a simple tee'
      ];
      portrait = [];
      for (let i = 0; i < poses.length; i++) {
        portrait.push(await generateImage(buildPortraitPrompt(a, poses[i]), { seed: baseSeed + 1 + i, hd: true }));
      }
    }
    text += '\n\nHere are two more portraits of your soulmate, the same person in new moments. Together with the first portrait from your base reading, you now have all three.';
    subject = `${a.name ? a.name + ', your' : 'Your'} extended Soulmate reading is inside`;
    heading = 'Your Extended Soulmate Reading ✨';
  }
  else if (type === 'archetype') {
    const arch = p.archetype || 'your love archetype';
    const profLine = p.profile ? ` Their full quiz profile (result scores): ${p.profile}. Use their secondary leanings to make this specific to THEM, not generic.` : '';
    const ansLine = p.answers ? ` Their own answers in the quiz were: ${p.answers}. Reference these real choices naturally so the reading feels personally theirs.` : '';
    text = await generateText({ system: SYSTEM_GENERIC, user: `Write an extended "Love Archetype" reading for someone whose primary archetype is "${arch}". This is a self knowledge reading about HOW they love, grounded in the six love styles (Eros passionate, Ludus playful, Storge friendship based, Pragma practical, Mania all in, Agape selfless). Name the love style behind their archetype naturally, without jargon. It is about them, not about finding a specific partner.${profLine}${ansLine} Sections in order: What your type really means (core traits of your archetype), Your light (your strengths in love), Your shadow (your weaknesses and the traps your type falls into, honest but kind), What you need to feel loved, Who you harmonize with and who you clash with (which love styles fit yours and which create friction), How to grow into the best version of your type, Your love blend (show their mix as playful percentages across the styles, based on their scores), Your love motto (one memorable line). Disclaimer. 800-1000 words. Warm, specific, never clinical.${focusLine}` });
    subject = 'Your extended Love Archetype reading is inside';
    heading = `Your Love Archetype: ${arch}`;
  }
  else if (type === 'pastlife') {
    const persona = p.persona || 'your past life';
    const profLineP = p.profile ? ` Their full quiz profile (persona scores): ${p.profile}. Blend in their secondary leanings so this life feels uniquely theirs.` : '';
    const ansLineP = p.answers ? ` Their own answers in the quiz were: ${p.answers}. Weave these real choices into the story so it feels personally theirs.` : '';
    const sj = (p.lives && p.soulage) ? { lives: parseInt(p.lives, 10) || soulJourney(seed).lives, age: p.soulage } : soulJourney(seed);
    text = await generateText({ system: SYSTEM_GENERIC, user: `Write an extended, cinematic "Past Life" reading for someone whose past life was "${persona}". Ground it in karmic astrology, where the South Node represents the soul's past life signature and its karmic lesson. This person is ${sj.age} whose soul has lived roughly ${sj.lives} lifetimes.${profLineP}${ansLineP} Sections in order: The world you lived in (the era and place), Who you were and your daily life, How that life ended, What your soul carried forward (a gift and a wound), Your karmic lesson (frame it through the South Node, the pattern your soul is here to grow beyond), Your soul age (weave in that you are ${sj.age} of about ${sj.lives} lifetimes), How it echoes in you today (an unexplained fear, a natural talent, a place you are drawn to), A message from that self, Disclaimer. 800-1000 words, vivid and warm.${focusLine}` });
    const selfG = p.gender === 'woman' ? 'woman' : p.gender === 'man' ? 'man' : 'person';
    if (media) portrait = await themedPortrait(`a cinematic period-accurate portrait of a ${selfG} who lived as ${persona}, atmospheric, head and shoulders`, seed);
    subject = 'Your extended Past Life reading is inside';
    heading = `Your Past Life: ${persona}`;
  }
  else if (type === 'tarot') {
    const cards = p.cards || 'seven cards';
    const sit = p.situation ? ` Their situation in love: ${p.situation}.` : '';
    const mind = p.mind ? ` On their mind: ${p.mind}.` : '';
    const want = p.want ? ` They most want to know: ${p.want}.` : '';
    const feel = p.feel ? ` Lately they feel: ${p.feel}.` : '';
    const help = p.help ? ` What would help them most: ${p.help}.` : '';
    text = await generateText({ system: SYSTEM_GENERIC, user: `Write a deep, personal LOVE tarot reading about this person's love life.${sit}${mind}${want}${feel}${help} The cards drawn, in order, are: ${cards}. Each card is marked (upright) or (reversed); an upright card carries its open, flowing meaning, and a reversed card carries its shadow, blocked or inward meaning, so read each card in the orientation given. Do not use fixed position labels. Weave all the cards together into ONE flowing, tailored answer to their exact question and situation. Cover naturally: where their heart is now, what the cards reveal about their question, an honest read of the light and the shadow, a sense of love timing (a season or window, never a date), and one clear next step. Frame as reflection and entertainment, not fortune telling. Disclaimer. 800-1000 words. Warm and specific.${focusLine}` });
    subject = 'Your Love Tarot reading is inside';
    heading = 'Your Love Tarot Reading';
  }
  else if (type === 'compat') {
    const n1 = p.n1 || 'You', n2 = p.n2 || 'Them', z1 = p.z1 || '', z2 = p.z2 || '', status = p.status || 'together', score = p.score || '';
    const want = p.want ? ` They most want to know: ${p.want}.` : '';
    const feel = p.feel ? ` It usually feels: ${p.feel}.` : '';
    const hard = p.hard ? ` The hardest part between them: ${p.hard}.` : '';
    const rel = p.relsign ? ` Their relationship's own composite sign is ${p.relsign}, use exactly this in the relationship sign section.` : '';
    const more = p.more ? ` More context they shared: ${p.more}.` : '';
    const signRule = ` STRICT ASTROLOGY RULES: ${n1}'s only zodiac sign is ${z1}, and ${n2}'s only zodiac sign is ${z2}. Use these exact Sun signs and their elements, consistently, in every section. Never mention any other zodiac sign for either person and never contradict these. Do NOT invent Moon signs or Rising signs. Do NOT turn anyone's birth city into a personality trait, a city is only a place, not a character. Base all the astrology only on these two Sun signs and their elements.`;
    const audience = ` AUDIENCE: the reader is ${n1}; ${n2} is not reading this. Write the ENTIRE reading addressed to ${n1} as "you". Give advice, guidance and the next step ONLY to ${n1}. You may describe what ${n2} needs and how ${n2} feels, so ${n1} understands ${n2} better, but never give instructions, tasks or advice to ${n2}.`;
    text = await generateText({ system: SYSTEM_GENERIC, user: `Write an extended LOVE compatibility reading for ${n1} (${z1}) and ${n2} (${z2}), relationship status: "${status}", overall match around ${score}%.${signRule}${audience}${want}${feel}${hard}${rel}${more} Tailor everything to their status and question, do not force sections that do not fit. Cover naturally, all written to ${n1}: Your relationship's own sign (treat the relationship itself as its own being with a composite zodiac personality, name it), Your dynamic in one vivid phrase, Your elemental chemistry (from the two Sun signs only), Where you flow, Where the friction is (honest), How to reach ${n2} when you clash (written for you, practical, only your side to work on), What you need to feel loved and what ${n2} needs (describe ${n2}'s needs so you understand them, do not instruct ${n2}), Your connection type (say whether you two read as soulmates, twin flames, karmic partners, or kindred souls, and why), Your karmic connection (whether your souls may have met before and what this bond is here to teach you), Your growth path, An honest read on where this could go, and one clear next step for you. Balanced and honest, not all positive. Disclaimer. 900-1100 words.${focusLine}` });
    subject = `Your Love Compatibility reading, ${n1} and ${n2}`;
    heading = `${n1} & ${n2}: Your Compatibility`;
  }
  else { console.warn('[gumroad] no generator for', type); return null; }

  text = noDashes(text);
  heading = noDashes(heading);
  subject = noDashes(subject);

  if (media && email) await sendReadingEmail(email, subject, heading, text, portrait, emailOpts);
  if (media) console.log('[paid] delivered', type, 'to', email);
  return { subject, heading, text, portrait };
}

function permalinkSlug(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m = s.match(/\/l\/([^/?#]+)/);        // full checkout URL -> slug
  return (m ? m[1] : s).replace(/[?#].*$/, '').trim();
}

app.post('/webhook/gumroad', express.urlencoded({ extended: true }), async (req, res) => {
  res.status(200).send('ok'); // ack fast, work after
  try {
    const b = req.body || {};
    const p = b.url_params || {};
    // Try every field Gumroad might use to identify the product, in slug form.
    const cands = [b.product_permalink, b.permalink, b.short_product_id, b.product_id]
      .map(permalinkSlug).filter(Boolean);
    let type = null, matched = '';
    for (const c of cands) { if (PAID_PRODUCTS[c]) { type = PAID_PRODUCTS[c]; matched = c; break; } }
    // Explicit override passed by our own pages as a url_param.
    if (!type && p.ptype && Object.values(PAID_PRODUCTS).includes(p.ptype)) { type = p.ptype; matched = 'ptype:' + p.ptype; }
    if (!type) { console.warn('[gumroad] unknown product', cands, 'ptype=', p.ptype); return; }
    const saleId = b.sale_id || b.order_number || String(Date.now());
    if (processedSales.has(saleId)) return;
    processedSales.add(saleId);
    const email = b.email || p.email;
    console.log('[gumroad] sale', matched, '->', type, saleId, email);
    await generateForType(type, p, email, saleId);
  } catch (e) { console.error('[gumroad] fail', e); }
});

// ---- Reading preview / test tool (no payment, no email, text only) ----
let previewCount = 0;
const PREVIEW_MAX = 300;
function escHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
app.get('/preview', async (req, res) => {
  const q = req.query || {};
  const PKEY = process.env.PREVIEW_KEY || 'li2026';
  const types = ['archetype','pastlife','tarot','compat','soulmate','soulmate-deep'];
  const ptype = types.includes(q.ptype) ? q.ptype : 'archetype';
  let out = '';
  const act = q.send ? 'send' : (q.go ? 'go' : '');
  if (act) {
    if (q.key !== PKEY) out = `<div class="err">Wrong key.</div>`;
    else if (previewCount >= PREVIEW_MAX) out = `<div class="err">Limit reached for now, try again later.</div>`;
    else if (act === 'send' && !String(q.email||'').includes('@')) out = `<div class="err">Adaugă emailul tău ca să primești varianta completă (cu portret).</div>`;
    else {
      previewCount++;
      try {
        if (act === 'send') {
          await generateForType(ptype, q, q.email, 'sim-' + previewCount, {});
          out = `<div class="reading"><h2>✓ Trimis</h2><p>Readingul complet (cu portret) a plecat către <b>${escHtml(q.email)}</b>. Ajunge în 1 to 2 minute, verifică și spam/promotions. E identic cu ce primește un client care plătește.</p></div>`;
        } else {
          const withImg = String(q.img||'') === '1';
          const r = await generateForType(ptype, q, null, 'preview-' + previewCount, { textOnly: !withImg });
          const body = (r && r.text) ? r.text : '(no text generated)';
          const html = '<p>' + escHtml(body).replace(/\n\n+/g,'</p><p>').replace(/\n/g,'<br>') + '</p>';
          let imgs = '';
          if (withImg && r && r.portrait) {
            const files = (Array.isArray(r.portrait) ? r.portrait : [r.portrait]).filter(Boolean);
            imgs = files.map(f => `<img src="/portrait/${path.basename(f)}" style="max-width:340px;width:100%;border-radius:14px;margin:10px 8px 0;display:inline-block">`).join('');
          }
          out = `<div class="reading"><h2>${escHtml(r && r.heading || '')}</h2>${imgs}${html}</div>`;
        }
      } catch(e){ out = `<div class="err">Error: ${escHtml(e && e.message || e)}</div>`; }
    }
  }
  const inp = (n,ph) => `<label>${n}<input name="${n}" value="${escHtml(q[n]||'')}" placeholder="${escHtml(ph||'')}"></label>`;
  const exLink = o => '?' + Object.entries(o).map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');
  const K = 'li2026';
  const examples = [
    ['Soulmate', { ptype:'soulmate', key:K, name:'Ana', meet:'woman', age:'25-34', energy:'warm', look:'soft', value:'loyalty and real depth', lightning:'deep late-night talks; someone who chooses me back' }],
    ['Soulmate Premium', { ptype:'soulmate-deep', key:K, name:'Ana', meet:'woman', age:'25-34', energy:'warm', look:'soft', value:'loyalty and real depth', lightning:'deep late-night talks; someone who chooses me back' }],
    ['Love Archetype', { ptype:'archetype', key:K, archetype:'The Dreamer', profile:'The Dreamer (3/6), The Muse (2/6), The Flame (1/6)', answers:'Deep talks under the stars | Making something beautiful together', pref:'woman', focus:'Will I find someone who really gets me?' }],
    ['Past Life', { ptype:'pastlife', key:K, persona:'The Renaissance Painter, Florence', profile:'The Painter (3/6), The Mystic (2/6)', answers:'Making something beautiful | A quiet life of craft', gender:'woman', focus:"I've always been drawn to old art and Italy" }],
    ['Tarot', { ptype:'tarot', key:K, cards:'The Star, The Lovers, The Sun', focus:'What is coming for me in love?' }],
    ['Compatibility', { ptype:'compat', key:K, n1:'Ana', n2:'Mihai', z1:'Leo', z2:'Scorpio', status:'together', score:'78', focus:'Will we last long-term?' }],
  ];
  const exHtml = examples.map(([label, o]) => `<a href="${exLink(o)}" style="color:#7a3f9d;text-decoration:underline;white-space:nowrap">${label}</a>`).join(' &nbsp;·&nbsp; ');
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reading preview</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#241033;background:#faf7fc}
h1{font-family:Georgia,serif}label{display:block;font-size:13px;color:#6b5a78;margin:8px 0 2px}
input,select{width:100%;padding:9px 11px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{margin-top:16px;background:#7a3f9d;color:#fff;border:0;border-radius:999px;padding:12px 26px;font-size:15px;font-weight:600;cursor:pointer}
.reading{background:#fff;border:1px solid #eee3f2;border-radius:16px;padding:22px 26px;margin-top:26px;line-height:1.65}
.reading h2{font-family:Georgia,serif;color:#7a3f9d}.err{background:#fdecea;color:#b5372e;padding:12px;border-radius:8px;margin-top:16px}
.hint{font-size:12px;color:#8a7a95}</style>
<h1>🔮 Reading preview, test tool</h1>
<p class="hint">Alege tipul, completează câmpurile relevante, apoi „Preview text" (doar text pe ecran) sau „Trimite pe email" (identic, cu portret). Rulează de câte ori vrei.</p>
<div style="font-size:13.5px;color:#3d2d49;background:#f0e7f8;border-radius:12px;padding:12px 14px;margin:2px 0 18px;line-height:1.9">👉 <b>Exemple</b> (click ca să completeze formularul, apoi apeși Preview sau Trimite): ${exHtml}</div>
<form method="get">
<label>Reading type<select name="ptype">${types.map(t=>`<option ${t===ptype?'selected':''}>${t}</option>`).join('')}</select></label>
<div class="row">${inp('archetype','ex: The Devoted')}${inp('persona','ex: The Desert Nomad, Silk Road')}</div>
<div class="row">${inp('cards','ex: The Lovers, The Wheel, The Wish')}${inp('focus','întrebarea / inputul lor')}</div>
${inp('profile','ex: The Devoted (2/6), The Flame (2/6), The Dreamer (1/6)')}
${inp('answers','răspunsurile din test, separate cu |')}
<div class="row">${inp('n1','nume 1')}${inp('n2','nume 2')}</div>
<div class="row">${inp('z1','zodie 1')}${inp('z2','zodie 2')}</div>
<div class="row">${inp('status','status relație')}${inp('score','ex: 78')}</div>
<div class="row">${inp('gender','past life, tu azi: woman / man')}${inp('pref','archetype ideal: woman / man / either')}</div>
<div class="row">${inp('name','soulmate, numele tău')}${inp('meet','soulmate e: woman / man')}</div>
<div class="row">${inp('age','soulmate: 18-24 / 25-34 / 35-44 / 45+')}${inp('energy','soulmate: grounded / adventurous / warm / mysterious')}</div>
<div class="row">${inp('look','soulmate: soft / bold / natural / dark')}${inp('value','soulmate: ce prețuiești')}</div>
${inp('lightning','soulmate: răspunsuri scurte, ce cauți')}
<label>email (pentru varianta identică, cu portret)<input name="email" value="${escHtml(q.email||'')}" placeholder="li.lidiaserban@gmail.com"></label>
<label>key<input name="key" value="${escHtml(q.key||'')}" placeholder="preview key"></label>
<button type="submit" name="go" value="1">Preview text →</button>
<button type="submit" name="send" value="1" style="background:#2b7a4b">Trimite identic pe email (cu portret) →</button>
</form>
${out}`);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Soulmate server on :${PORT} (support ${SUPPORT_EMAIL})`));
}

module.exports = {
  generateForType,
  buildReadingPrompt, buildPortraitPrompt, seedFrom,
  generateText, generateImage,
};
