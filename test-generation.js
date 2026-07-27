/**
 * SOULMATE — end-to-end generation test (NO Paddle, NO server needed)
 * -------------------------------------------------------------------
 * Simulates a paid €17 order and runs the real AI engine, so you can
 * confirm your API keys work and see a real reading + portrait.
 *
 * Before running:
 *   1. Copy .env.example to .env and fill in your keys.
 *   2. In .env set TEST_EMAIL to your own email address.
 *   3. Run:  npm install   (once)
 *   4. Run:  npm run test:gen
 *
 * What you should get:
 *   - the reading printed in the Terminal
 *   - a file  portrait_*.png  in this folder
 *   - an email in your inbox with the reading + portrait attached
 */

try { require('dotenv').config(); } catch {}

// Give the test a price id and make the server match it (must be set BEFORE requiring the server).
process.env.PRICE_ENTRY = process.env.PRICE_ENTRY || 'pri_entry_test';

const { handleCompletedTransaction } = require('./soulmate_server.js');

// A fake "transaction.completed" payload, exactly shaped like Paddle's,
// carrying sample quiz answers in custom_data.
const fakeTransaction = {
  id: 'txn_test_0001',
  customer_id: 'cus_test_0001',
  items: [{ price: { id: process.env.PRICE_ENTRY } }],   // entry €17 only
  custom_data: {
    name: 'Maria',
    meet: 'man',
    age: '25-34',
    energy: 'mysterious',
    look: 'dark',
    value: 'loyalty',
    lightning: ['wine', 'ocean', 'caller', 'night owl'],
    email: process.env.TEST_EMAIL || 'you@email.com',
    consent: true,
  },
};

(async () => {
  console.log('▶ Generating a test reading + portrait for Maria…\n');
  try {
    const result = await handleCompletedTransaction(fakeTransaction);
    console.log('\n──────── READING ────────\n');
    console.log(result.sections.reading);
    console.log('\n──────── PORTRAIT ────────');
    console.log('saved file:', result.images[0]);
    console.log('\n✅ Done. Check your inbox at', fakeTransaction.custom_data.email);
  } catch (err) {
    console.error('\n❌ Something failed:', err.message);
    console.error('\nCommon fixes:');
    console.error('  401  → your API key is wrong or missing in .env');
    console.error('  429  → add a few $ of credit to your OpenAI account');
    console.error('  "model_not_found" → update TEXT_MODEL / IMAGE_MODEL in .env to a current model name');
    process.exit(1);
  }
})();
