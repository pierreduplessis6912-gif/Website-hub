const cron = require('node-cron');
const express = require('express');
const { fetchAllRates } = require('./fetch');
const { getRates, getAllSectors, getRateCount, initDb } = require('./db');

const app = express();
const PORT = process.env.ORACLE_PORT || 3002;

initDb();

app.get('/pricing-oracle', (req, res) => {
  const { sector, province } = req.query;
  if (!sector) return res.status(400).json({ error: 'sector required' });
  const rates = getRates(sector, province || null);
  if (!rates || rates.length === 0) {
    return res.json({
      found: false,
      message: `No rates on file for sector: ${sector}. NMW floor applies.`,
      nmw_floor: { rate: 30.23, unit: 'per hour', effective: '2026-03-01', source: 'NMW Act, Gazette 54075' }
    });
  }
  res.json({ found: true, rates });
});

app.get('/pricing-oracle/sectors', (req, res) => res.json(getAllSectors()));
app.get('/pricing-oracle/fetch', async (req, res) => {
  try {
    const results = await fetchAllRates();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'pricing-oracle', rates: getRateCount() }));

cron.schedule('0 2 1 * *', async () => {
  console.log('[Oracle] Monthly fetch starting...');
  try { const r = await fetchAllRates(); console.log('[Oracle] Done:', r); }
  catch (e) { console.error('[Oracle] Failed:', e.message); }
});

app.listen(PORT, () => {
  console.log(`[Oracle] Running on port ${PORT}`);
  if (getRateCount() === 0) {
    console.log('[Oracle] Empty DB — running initial fetch...');
    fetchAllRates().then(r => console.log('[Oracle] Initial fetch:', r)).catch(e => console.error('[Oracle] Error:', e.message));
  }
});
