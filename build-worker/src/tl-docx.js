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

// ── REAL MBD FORM GENERATORS ──────────────────────────────────────────────
// Genuine form layouts (matching the standard SBD/MBD structure used across
// virtually all SA municipal/provincial tenders), built as actual docx
// tables — not narrative prose describing the form. Pre-filled wherever we
// have real data; clearly marked "TO COMPLETE" where we don't (director
// details, ID numbers, addresses — fields this system doesn't collect yet).
// This is Phase 1 of the real submission pack. Phase 2 (pulling actual
// uploaded compliance certificates into the pack) is separate, not yet built.

const TO_COMPLETE = '________________ (TO COMPLETE)';

function fieldRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: LIGHT_GRAY, fill: LIGHT_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18 })] })] }),
      new TableCell({ width: { size: 65, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: value || TO_COMPLETE, size: 18, color: value ? '000000' : 'AA6600' })] })] }),
    ],
  });
}

function formHeader(formCode, formName) {
  return [
    new Paragraph({ text: '', pageBreakBefore: true }),
    new Paragraph({
      children: [new TextRun({ text: formCode, bold: true, size: 28, color: 'FFFFFF' })],
      shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
    }),
    new Paragraph({ children: [new TextRun({ text: formName, bold: true, size: 24 })] }),
    new Paragraph({ text: '' }),
  ];
}

// MBD 1 — Tender Notice and Invitation to Bid (Details of Tenderer)
function buildMbd1(company, report) {
  return [
    ...formHeader('MBD 1', 'TENDER NOTICE AND INVITATION TO BID — DETAILS OF TENDERER'),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Bidder', company?.name),
      fieldRow('Trading As (if different)', null),
      fieldRow('Street Address', null),
      fieldRow('Postal Address', null),
      fieldRow('Contact Person', null),
      fieldRow('Enterprise Registration Number', company?.reg_number),
      fieldRow('CIDB CRS Number', company?.cidb_grade),
      fieldRow('TCS PIN', null),
      fieldRow('E-mail Address', company?.email),
      fieldRow('Telephone Number', null),
      fieldRow('Cellphone Number', company?.phone),
      fieldRow('B-BBEE Status Level', company?.bee_level ? 'Level ' + company.bee_level : null),
      fieldRow('CSD Supplier Number', company?.csd_maaa ? 'Registered' : null),
    ]}),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'DECLARATION', bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: 'I am duly authorised to represent the tenderer and hereby tender to supply the goods/render the services described, on the terms and conditions stipulated in the tender document.', italics: true, size: 18 })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name (Print)', null),
      fieldRow('Signature', '_________________ (sign in black ink)'),
      fieldRow('Capacity', null),
      fieldRow('Date', null),
    ]}),
  ];
}

// MBD 6.1 — Preference Points Claim Form (B-BBEE)
function buildMbd61(company) {
  const beeLevel = company?.bee_level ? parseInt(company.bee_level) : null;
  const pointsTable = [1,2,3,4,5,6,7,8].map(level => {
    const points = [20,18,14,12,8,6,4,2][level-1];
    const claimed = beeLevel === level ? String(points) : '';
    return new TableRow({ children: [
      new TableCell({ children: [new Paragraph('Level ' + level)] }),
      new TableCell({ children: [new Paragraph(String(points))] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: claimed, bold: !!claimed })] })] }),
    ]});
  });

  return [
    ...formHeader('MBD 6.1', 'PREFERENCE POINTS CLAIM FORM (80/20 SYSTEM)'),
    new Paragraph({ children: [new TextRun({ text: beeLevel ? `Bidder's B-BBEE Status: Level ${beeLevel} — see claimed points marked below` : 'B-BBEE level not on file — verify and complete manually', bold: true, color: beeLevel ? '2ECC71' : 'FF4757' })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      new TableRow({ children: ['B-BBEE Status Level', 'Points Allocated', 'Points Claimed'].map(h => new TableCell({
        shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 18 })] })],
      })) }),
      ...pointsTable,
    ]}),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Company/Firm', company?.name),
      fieldRow('Company Registration Number', company?.reg_number),
      fieldRow('Signature of Tenderer', '_________________ (sign in black ink)'),
      fieldRow('Date', null),
    ]}),
  ];
}

// MBD 4 — Declaration of Interest
function buildMbd4(company) {
  const questions = [
    'Are you presently in the service of the state?',
    'Have you been in the service of the state for the past twelve months?',
    'Do you have any relationship with persons in the service of the state involved in this bid\'s evaluation/adjudication?',
    'Are any directors/managers/principal shareholders in service of the state?',
    'Do you or any directors have interest in other related companies bidding for this contract?',
  ];
  return [
    ...formHeader('MBD 4', 'DECLARATION OF INTEREST'),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Company Registration Number', company?.reg_number),
      fieldRow('Tax Reference Number', null),
      fieldRow('VAT Registration Number', null),
    ]}),
    new Paragraph({ text: '' }),
    ...questions.flatMap(q => [
      new Paragraph({ children: [new TextRun({ text: q, bold: true, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: 'Answer: YES ☐   NO ☐    If YES, particulars: _________________________', size: 18 })] }),
      new Paragraph({ text: '' }),
    ]),
    new Paragraph({ children: [new TextRun({ text: 'DIRECTORS / TRUSTEES / MEMBERS / SHAREHOLDERS (compulsory)', bold: true })] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      new TableRow({ children: ['Full Name', 'ID Number', 'Tax Number', 'State Employee No.'].map(h => new TableCell({
        shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 16 })] })],
      })) }),
      ...[1,2,3].map(() => new TableRow({ children: [1,2,3,4].map(() => new TableCell({ children: [new Paragraph(TO_COMPLETE)] })) })),
    ]}),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Enterprise', company?.name),
      fieldRow('Signature', '_________________ (sign in black ink)'),
      fieldRow('Date', null),
    ]}),
  ];
}

// MBD 8 — Declaration of Past SCM Practices
function buildMbd8(company) {
  const questions = [
    'Is the bidder or any director listed on National Treasury\'s Database of Restricted Suppliers?',
    'Is the bidder or any director listed on the Register for Tender Defaulters?',
    'Was the bidder or any director convicted of fraud/corruption in the past 5 years?',
    'Does the bidder or any director owe municipal rates/taxes in arrears exceeding 3 months?',
    'Was any contract with an organ of state terminated in the past 5 years for failure to perform?',
  ];
  return [
    ...formHeader('MBD 8', 'DECLARATION OF BIDDER\'S PAST SCM PRACTICES'),
    ...questions.flatMap(q => [
      new Paragraph({ children: [new TextRun({ text: q, bold: true, size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: 'Answer: YES ☐   NO ☐    If YES, particulars: _________________________', size: 18 })] }),
      new Paragraph({ text: '' }),
    ]),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Enterprise', company?.name),
      fieldRow('Signature', '_________________ (sign in black ink)'),
      fieldRow('Witness 1', TO_COMPLETE),
      fieldRow('Witness 2', TO_COMPLETE),
      fieldRow('Date', null),
    ]}),
  ];
}

// MBD 9 — Certificate of Independent Bid Determination
function buildMbd9(company, report) {
  const statements = [
    'I have read and understand the contents of this Certificate',
    'I understand the bid will be disqualified if this Certificate is found untrue',
    'I am authorised by the bidder to sign this Certificate',
    'The bid was arrived at independently, without consultation/agreement with any competitor',
    'The terms of the bid have not been and will not be disclosed to any competitor before bid opening',
  ];
  return [
    ...formHeader('MBD 9', 'CERTIFICATE OF INDEPENDENT BID DETERMINATION'),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Bid Number', report?.tender_reference),
      fieldRow('Description', report?.tender_title),
      fieldRow('On Behalf Of (Bidder)', company?.name),
    ]}),
    new Paragraph({ text: '' }),
    ...statements.map(s => new Paragraph({ children: [new TextRun({ text: '☐  ' + s, size: 18 })] })),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name (Print)', null),
      fieldRow('Signature', '_________________ (sign in black ink)'),
      fieldRow('Capacity', null),
      fieldRow('Date', null),
    ]}),
  ];
}

// MBD 15 — Certificate for Payment of Municipal Services
function buildMbd15(company) {
  return [
    ...formHeader('MBD 15', 'CERTIFICATE FOR PAYMENT OF MUNICIPAL SERVICES'),
    new Paragraph({ children: [new TextRun({ text: 'MUST be signed before a Commissioner of Oaths', bold: true, color: 'FF4757' })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Enterprise', company?.name),
      fieldRow('Physical Business Address', null),
      fieldRow('Municipal Account Number', null),
    ]}),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'DIRECTOR / SHAREHOLDER / PARTNER DETAILS', bold: true })] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      new TableRow({ children: ['Name', 'Residential Address', 'Business Address', 'Municipal Account No.'].map(h => new TableCell({
        shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 16 })] })],
      })) }),
      ...[1,2].map(() => new TableRow({ children: [1,2,3,4].map(() => new TableCell({ children: [new Paragraph(TO_COMPLETE)] })) })),
    ]}),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name (Print)', null),
      fieldRow('Signature', '_________________ (sign before Commissioner of Oaths)'),
      fieldRow('Date', null),
    ]}),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'COMMISSIONER OF OATHS', bold: true, color: BRAND_ORANGE })] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Commissioner Name', TO_COMPLETE),
      fieldRow('Position', TO_COMPLETE),
      fieldRow('Official Stamp', '[Apply stamp here]'),
    ]}),
  ];
}

// Assembles all real MBD forms for the bidpack — Phase 1 of the genuine
// submission pack. Forms included match what's actually required by the
// vast majority of SA municipal/provincial tenders.
function buildRealFormsSection(company, report) {
  return [
    new Paragraph({ text: '', pageBreakBefore: true }),
    new Paragraph({ children: [new TextRun({ text: 'OFFICIAL BID FORMS — COMPLETE AND SIGN', bold: true, size: 32, color: BRAND_ORANGE })] }),
    new Paragraph({ children: [new TextRun({ text: 'Fields marked in orange require manual completion — this system does not yet hold this data. Verify every pre-filled field is current before submission.', italics: true, size: 18, color: '888888' })] }),
    ...buildMbd1(company, report),
    ...buildMbd4(company),
    ...buildMbd61(company),
    ...buildMbd8(company),
    ...buildMbd9(company, report),
    ...buildMbd15(company),
  ];
}


export async function generateProductRunDocx(run, report, company) {
  const companyName = company?.name;
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
    // Real, structured MBD forms — Phase 1 of the genuine submission pack.
    // Replaces the old narrative "transcription guide" approach: these are
    // actual form layouts, pre-filled with real company data where we have
    // it, clearly marked for manual completion where we don't.
    children.push(...buildRealFormsSection(company, report));
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
