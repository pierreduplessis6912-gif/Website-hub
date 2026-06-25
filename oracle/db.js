const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(__dirname, 'rates.db');
let db;

function getDb() {
  if (!db) db = new Database(DB_PATH);
  return db;
}

function initDb() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sector TEXT NOT NULL,
      province TEXT,
      grade TEXT,
      category TEXT,
      base_rate REAL,
      oncost_pct REAL,
      oncost_components TEXT,
      total_rate REAL,
      rate_unit TEXT DEFAULT 'per hour',
      effective_date TEXT,
      expiry_date TEXT,
      council_name TEXT,
      gazette_ref TEXT,
      source_url TEXT,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      raw_extract TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sector ON rates(sector);
    CREATE INDEX IF NOT EXISTS idx_sector_province ON rates(sector, province);
  `);
  console.log('[Oracle DB] Initialised');
}

function upsertRate(data) {
  const d = getDb();
  d.prepare('DELETE FROM rates WHERE sector=? AND (province=? OR (province IS NULL AND ? IS NULL)) AND grade=? AND effective_date=?')
    .run(data.sector, data.province||null, data.province||null, data.grade||null, data.effective_date);
  d.prepare(`INSERT INTO rates (sector,province,grade,category,base_rate,oncost_pct,oncost_components,total_rate,rate_unit,effective_date,expiry_date,council_name,gazette_ref,source_url,raw_extract) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(data.sector,data.province||null,data.grade||null,data.category||null,data.base_rate||null,data.oncost_pct||null,data.oncost_components||null,data.total_rate||null,data.rate_unit||'per hour',data.effective_date,data.expiry_date||null,data.council_name,data.gazette_ref||null,data.source_url,data.raw_extract||null);
}

function getRates(sector, province) {
  const d = getDb();
  if (province) {
    const rows = d.prepare('SELECT * FROM rates WHERE sector=? AND province=? ORDER BY effective_date DESC').all(sector, province);
    if (rows.length > 0) return rows;
  }
  return d.prepare('SELECT * FROM rates WHERE sector=? AND (province IS NULL OR province=?) ORDER BY effective_date DESC').all(sector, 'national');
}

function getAllSectors() {
  return getDb().prepare('SELECT DISTINCT sector, province, council_name, effective_date, source_url FROM rates ORDER BY sector').all();
}

function getRateCount() {
  return getDb().prepare('SELECT COUNT(*) as c FROM rates').get().c;
}

module.exports = { initDb, upsertRate, getRates, getAllSectors, getRateCount };