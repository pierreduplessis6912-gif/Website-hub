// ── TENDER LOGIX — DOCX GENERATION ───────────────────────────────────────
// Converts a product run's report_json (gonogo/pricing/bidpack) into a real,
// editable .docx file. Uses Packer.toArrayBuffer() — confirmed the only
// Workers-compatible export method (toBuffer() requires Node's Buffer API,
// unavailable in the Workers runtime even with nodejs_compat — confirmed via
// live testing, not assumption).
//
// Design principle: every document this generates must be genuinely editable
// in Word — real paragraphs, real tables, real headings — not an image or a
// locked layout. This is a hard product requirement, not a nice-to-have.

import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
         HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType } from 'docx';

const BRAND_ORANGE = 'FF6B1A';
const DARK_GRAY = '1C1D20';
const LIGHT_GRAY = 'F2F2F2';

// ── Minimal markdown → docx paragraph converter ───────────────────────────
// Handles exactly what our prompts actually produce: #/##/### headers,
// **bold**, | table | rows, > blockquotes, --- horizontal rules, plain
// paragraphs. Not a general-purpose markdown parser — deliberately scoped
// to what Claude's submission_document output actually contains.
function markdownToDocxElements(markdown) {
  if (!markdown) return [new Paragraph({ text: '(No content)' })];

  const lines = markdown.split('\n');
  const elements = [];
  let i = 0;
  let inTable = false;
  let tableRows = [];

  function flushTable() {
    if (tableRows.length === 0) return;
    const headerRow = tableRows[0];
    const dataRows = tableRows.slice(1);
    elements.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: headerRow.map(cell => new TableCell({
            shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
            children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true, color: 'FFFFFF' })] })],
          })),
        }),
        ...dataRows.map(row => new TableRow({
          children: row.map(cell => new TableCell({
            children: [new Paragraph({ children: parseBoldRuns(cell) })],
          })),
        })),
      ],
    }));
    elements.push(new Paragraph({ text: '' }));
    tableRows = [];
    inTable = false;
  }

  function parseBoldRuns(text) {
    // Splits on **bold** markers, returns an array of TextRun
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.filter(p => p.length).map(p => {
      if (p.startsWith('**') && p.endsWith('**')) {
        return new TextRun({ text: p.slice(2, -2), bold: true });
      }
      return new TextRun(p);
    });
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Table row detection
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      // Skip markdown separator rows like |---|---|
      if (!cells.every(c => /^:?-+:?$/.test(c))) {
        inTable = true;
        tableRows.push(cells);
      }
      i++;
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (trimmed === '' ) { elements.push(new Paragraph({ text: '' })); i++; continue; }
    if (trimmed === '---') { elements.push(new Paragraph({ text: '________________________________' })); i++; continue; }

    if (trimmed.startsWith('### ')) {
      elements.push(new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (trimmed.startsWith('## ')) {
      elements.push(new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (trimmed.startsWith('# ')) {
      elements.push(new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (trimmed.startsWith('> ')) {
      elements.push(new Paragraph({
        children: parseBoldRuns(trimmed.slice(2)),
        indent: { left: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: BRAND_ORANGE, space: 8 } },
      }));
    } else if (trimmed.startsWith('```')) {
      // Skip code fence markers; content between them rendered as plain monospace-ish text
      i++;
      continue;
    } else {
      elements.push(new Paragraph({ children: parseBoldRuns(trimmed) }));
    }
    i++;
  }
  if (inTable) flushTable();

  return elements;
}

// ── BOQ table builder — shared by pricing and bidpack reports ────────────
function buildBoqTable(boq, boqTotals) {
  if (!boq || !boq.length) return [];

  const headerCells = ['Item', 'Unit', 'Qty', 'Rate', 'Total', 'Confidence'];
  const rows = [
    new TableRow({
      children: headerCells.map(h => new TableCell({
        shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 18 })] })],
      })),
    }),
    ...boq.map(item => new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.line_item || '', size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.unit || '', size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(item.quantity ?? ''), size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.unit_rate ? 'R' + item.unit_rate.toLocaleString() : '', size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.total ? 'R' + item.total.toLocaleString() : '', size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.confidence || '', size: 18 })] })] }),
      ],
    })),
  ];

  if (boqTotals?.recommended_bid) {
    rows.push(new TableRow({
      children: [
        new TableCell({
          columnSpan: 4,
          shading: { type: ShadingType.SOLID, color: LIGHT_GRAY, fill: LIGHT_GRAY },
          children: [new Paragraph({ children: [new TextRun({ text: 'Recommended Bid', bold: true, size: 18 })] })],
        }),
        new TableCell({
          columnSpan: 2,
          shading: { type: ShadingType.SOLID, color: LIGHT_GRAY, fill: LIGHT_GRAY },
          children: [new Paragraph({ children: [new TextRun({ text: 'R' + boqTotals.recommended_bid.toLocaleString(), bold: true, size: 18 })] })],
        }),
      ],
    }));
  }

  return [
    new Paragraph({ text: 'Bill Of Quantities', heading: HeadingLevel.HEADING_2 }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
    new Paragraph({ text: '' }),
  ];
}

// ── Checklist table builder — shared by eligibility/compliance sections ──
function buildChecklistSection(title, items, statusKey, labelKey, notesKey) {
  if (!items || !items.length) return [];
  const statusIcon = (s) => {
    if (s === null || s === undefined) return '→';
    const v = (s || '').toUpperCase();
    if (v === 'MET' || v === 'LOW') return '✓';
    if (v === 'UNMET' || v === 'EXPIRED' || v === 'CRITICAL MISMATCH' || v === 'HIGH') return '✗';
    if (v === 'MEDIUM') return '!';
    return '?';
  };
  return [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_2 }),
    ...items.flatMap(item => [
      new Paragraph({
        children: [
          new TextRun({ text: statusIcon(item[statusKey]) + '  ', bold: true }),
          new TextRun({ text: item[labelKey] || '', bold: true }),
        ],
      }),
      ...(item[notesKey] ? [new Paragraph({ children: [new TextRun({ text: item[notesKey], italics: true, size: 18, color: '666666' })], indent: { left: 360 } })] : []),
      new Paragraph({ text: '' }),
    ]),
  ];
}

// ── Main export — builds the full Document for a given product run ───────
export async function generateProductRunDocx(run, report, companyName) {
  const product = run.product;
  const title = report.tender_title || 'Tender Analysis';
  const ref = report.tender_reference;

  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    ...(ref ? [new Paragraph({ children: [new TextRun({ text: 'Ref: ' + ref, italics: true, color: '666666' })] })] : []),
    new Paragraph({ children: [new TextRun({ text: 'Prepared for: ' + (companyName || ''), color: '666666' })] }),
    new Paragraph({ text: '' }),
  ];

  if (product === 'gonogo' && report.verdict) {
    const verdictColor = report.verdict === 'GO' ? '2ECC71' : report.verdict === 'NO_GO' ? 'FF4757' : BRAND_ORANGE;
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: report.verdict.replace('_', ' '), bold: true, size: 56, color: verdictColor })],
      }),
      new Paragraph({ children: [new TextRun({ text: report.verdict_summary || '' })] }),
      new Paragraph({ text: '' }),
      ...buildChecklistSection('Eligibility', report.eligibility, 'status', 'requirement', 'notes'),
      ...buildChecklistSection('Compliance', report.compliance_checklist, 'risk_level', 'item', 'notes'),
      ...buildChecklistSection('Risk Flags', report.risk_flags, 'severity', 'flag', 'mitigation'),
      ...buildChecklistSection('How To Gain An Edge', report.edge_recommendations, null, 'action', 'impact'),
    );
    if (report.future_readiness) {
      children.push(
        new Paragraph({ text: 'Path To Future Tenders', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ children: [new TextRun({ text: report.future_readiness })] }),
      );
    }
  }

  if (product === 'pricing' || product === 'bidpack') {
    if (report.competitive_landscape) {
      children.push(
        new Paragraph({ text: 'Competitive Landscape', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ children: [new TextRun({ text: report.competitive_landscape })] }),
        new Paragraph({ text: '' }),
      );
    }
    children.push(...buildBoqTable(report.boq, report.boq_totals));
    if (report.pricing_disclaimer) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: report.pricing_disclaimer, italics: true, size: 16, color: '888888' })],
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 8 } },
        }),
      );
    }
  }

  if (product === 'bidpack') {
    children.push(...buildChecklistSection('Compliance Checklist', report.compliance_checklist, 'status', 'item', 'notes'));
    if (report.submission_document) {
      children.push(
        new Paragraph({ text: '', pageBreakBefore: true }),
        ...markdownToDocxElements(report.submission_document),
      );
    }
  }

  const doc = new Document({
    sections: [{ children }],
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
        heading1: { run: { color: DARK_GRAY, bold: true, size: 32 } },
        heading2: { run: { color: BRAND_ORANGE, bold: true, size: 26 } },
        heading3: { run: { color: DARK_GRAY, bold: true, size: 22 } },
        title: { run: { color: DARK_GRAY, bold: true, size: 44 } },
      },
    },
  });

  return await Packer.toArrayBuffer(doc);
}
