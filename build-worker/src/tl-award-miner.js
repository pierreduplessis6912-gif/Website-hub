// ── AWARD MINER ───────────────────────────────────────────────────────────
// Pulls OCDS releases from National Treasury's eTenders API, extracts
// buyer/supplier/award relationships, and builds a procurement intelligence
// graph in tl_buyers, tl_suppliers, tl_tender_notices, tl_awards.
//
// Free, legal, Treasury-licensed for commercial use:
// https://ocds-api.etenders.gov.za/swagger/v1/swagger.json

const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';

// ── Main mining entrypoint — call from cron or admin endpoint ─────────────
export async function mineAwards(env, dateFrom, dateTo, pageSize = 200) {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  await env.TL_DB.prepare(`
    INSERT INTO tl_award_mining_log (id, date_from, date_to, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `).bind(runId, dateFrom, dateTo, startedAt).run();

  let releasesProcessed = 0;
  let awardsFound = 0;
  let newBuyers = 0;
  let newSuppliers = 0;
  let pageNumber = 1;

  try {
    while (true) {
      const url = `${OCDS_BASE}?PageNumber=${pageNumber}&PageSize=${pageSize}&dateFrom=${dateFrom}&dateTo=${dateTo}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        console.warn('[AwardMiner] API error on page', pageNumber, res.status);
        break;
      }
      const data = await res.json();
      const releases = data.releases || [];
      if (releases.length === 0) break;

      for (const release of releases) {
        releasesProcessed++;
        const tender = release.tender || {};
        const buyer = release.buyer || {};
        const ocid = release.ocid;

        // ── Upsert buyer ──────────────────────────────────────────────────
        if (buyer.id && buyer.name) {
          const existing = await env.TL_DB.prepare('SELECT id FROM tl_buyers WHERE id=?').bind(buyer.id).first();
          if (!existing) {
            newBuyers++;
            await env.TL_DB.prepare(`
              INSERT INTO tl_buyers (id, name, province, total_tenders_seen)
              VALUES (?, ?, ?, 1)
            `).bind(buyer.id, buyer.name, tender.province || null).run();
          } else {
            await env.TL_DB.prepare(`
              UPDATE tl_buyers SET total_tenders_seen = total_tenders_seen + 1, last_seen_at = CURRENT_TIMESTAMP
              WHERE id=?
            `).bind(buyer.id).run();
          }
        }

        // ── Upsert tender notice ─────────────────────────────────────────
        if (ocid) {
          await env.TL_DB.prepare(`
            INSERT INTO tl_tender_notices
              (ocid, tender_id, title, status, buyer_id, province, category, procurement_method,
               tender_period_start, tender_period_end, briefing_compulsory, briefing_date, date_published, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ocid) DO UPDATE SET
              status=excluded.status,
              raw_json=excluded.raw_json
          `).bind(
            ocid,
            tender.id || null,
            tender.title || null,
            tender.status || null,
            buyer.id || null,
            tender.province || null,
            tender.category || null,
            tender.procurementMethodDetails || tender.procurementMethod || null,
            tender.tenderPeriod?.startDate || null,
            tender.tenderPeriod?.endDate || null,
            tender.briefingSession?.compulsory ? 1 : 0,
            tender.briefingSession?.date || null,
            release.date || null,
            JSON.stringify(release).slice(0, 50000) // cap raw storage
          ).run().catch(e => console.warn('[AwardMiner] tender upsert failed:', e.message));
        }

        // ── Process awards ───────────────────────────────────────────────
        const awards = release.awards || [];
        for (const award of awards) {
          if (!award.id) continue;
          awardsFound++;

          const suppliers = award.suppliers || [];
          const supplier = suppliers[0] || {};
          const supplierId = supplier.id || null;
          const supplierName = supplier.name || award.title || null;
          const value = award.value?.amount || 0;
          const currency = award.value?.currency || 'ZAR';

          // Upsert supplier
          if (supplierId && supplierName) {
            const existingSupplier = await env.TL_DB.prepare('SELECT id FROM tl_suppliers WHERE id=?').bind(supplierId).first();
            if (!existingSupplier) {
              newSuppliers++;
              await env.TL_DB.prepare(`
                INSERT INTO tl_suppliers (id, name, total_awards_won, total_award_value)
                VALUES (?, ?, 1, ?)
              `).bind(supplierId, supplierName, value).run().catch(() => {});
            } else {
              await env.TL_DB.prepare(`
                UPDATE tl_suppliers SET total_awards_won = total_awards_won + 1,
                  total_award_value = total_award_value + ?, last_seen_at = CURRENT_TIMESTAMP
                WHERE id=?
              `).bind(value, supplierId).run().catch(() => {});
            }
          }

          // Compute cycle days (award date vs tender period start)
          let cycleDays = null;
          if (release.date && tender.tenderPeriod?.startDate) {
            try {
              const start = new Date(tender.tenderPeriod.startDate);
              const awardDate = new Date(release.date);
              cycleDays = Math.round((awardDate - start) / (1000 * 60 * 60 * 24));
            } catch(e) {}
          }

          const awardCompositeId = `${ocid}-${award.id}`;
          await env.TL_DB.prepare(`
            INSERT INTO tl_awards
              (id, ocid, buyer_id, supplier_id, supplier_name, value_amount, value_currency,
               status, description, category, province, award_date, cycle_days)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status=excluded.status,
              value_amount=excluded.value_amount
          `).bind(
            awardCompositeId, ocid, buyer.id || null, supplierId, supplierName,
            value, currency, award.status || null, award.description || null,
            tender.category || null, tender.province || null,
            release.date || null, cycleDays
          ).run().catch(e => console.warn('[AwardMiner] award upsert failed:', e.message));
        }
      }

      if (releases.length < pageSize) break; // last page
      pageNumber++;
      if (pageNumber > 50) break; // safety cap — 50 pages max per run
    }

    await env.TL_DB.prepare(`
      UPDATE tl_award_mining_log
      SET releases_processed=?, awards_found=?, new_buyers=?, new_suppliers=?,
          status='complete', completed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(releasesProcessed, awardsFound, newBuyers, newSuppliers, runId).run();

    console.log(`[AwardMiner] Complete — releases:${releasesProcessed} awards:${awardsFound} newBuyers:${newBuyers} newSuppliers:${newSuppliers}`);
    return { success: true, releasesProcessed, awardsFound, newBuyers, newSuppliers, runId };

  } catch(e) {
    await env.TL_DB.prepare(`
      UPDATE tl_award_mining_log SET status='failed', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(e.message, runId).run().catch(() => {});
    console.error('[AwardMiner] Failed:', e.message);
    return { success: false, error: e.message, releasesProcessed, awardsFound };
  }
}

// ── Buyer Intelligence query — used by Go/No-Go and Bid Pack prompts ──────
export async function getBuyerIntelligence(env, buyerName) {
  if (!buyerName) return null;

  const buyer = await env.TL_DB.prepare(
    'SELECT * FROM tl_buyers WHERE name LIKE ? LIMIT 1'
  ).bind(`%${buyerName}%`).first();

  if (!buyer) return null;

  const awards = await env.TL_DB.prepare(`
    SELECT supplier_name, value_amount, category, award_date, cycle_days, description
    FROM tl_awards WHERE buyer_id=? ORDER BY award_date DESC LIMIT 20
  `).bind(buyer.id).all();

  const stats = await env.TL_DB.prepare(`
    SELECT COUNT(*) as total_awards, AVG(cycle_days) as avg_cycle_days,
           AVG(value_amount) as avg_value, COUNT(DISTINCT supplier_id) as unique_suppliers
    FROM tl_awards WHERE buyer_id=?
  `).bind(buyer.id).first();

  // Infer EME/QSE win rate from description field
  const allAwards = awards.results || [];
  const emeCount = allAwards.filter(a => /\bEME\b/i.test(a.description || '')).length;
  const qseCount = allAwards.filter(a => /\bQSE\b/i.test(a.description || '')).length;

  return {
    buyer_name: buyer.name,
    total_tenders_seen: buyer.total_tenders_seen,
    total_awards: stats?.total_awards || 0,
    avg_cycle_days: stats?.avg_cycle_days ? Math.round(stats.avg_cycle_days) : null,
    avg_award_value: stats?.avg_value || null,
    unique_suppliers: stats?.unique_suppliers || 0,
    eme_qse_inferred_pct: allAwards.length ? Math.round(((emeCount + qseCount) / allAwards.length) * 100) : null,
    recent_awards: allAwards.slice(0, 10),
  };
}
