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
         HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
         Header, Footer } from 'docx';

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

// ── Phase 2 — REAL verified compliance documents on file ─────────────────
// Lists every certificate this company has actually uploaded and had
// verified through the compliance system (CIDB, B-BBEE, tax, etc), with
// real status and expiry — pulled from tl_compliance_documents, not
// self-reported text. This is advisory (branded section), since it's a
// status summary, not a document to submit itself — the actual certificate
// files still need to be physically attached by the bidder (see note).
function buildComplianceDocumentsSection(complianceDocuments) {
  if (!complianceDocuments || !complianceDocuments.length) {
    return [
      new Paragraph({ text: 'Verified Compliance Documents On File', heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ children: [new TextRun({ text: 'No compliance documents have been uploaded and verified yet for this company. Upload certificates via the Compliance Status section of your dashboard so future submission packs can reference them directly.', italics: true, color: '888888' })] }),
      new Paragraph({ text: '' }),
    ];
  }

  const rows = complianceDocuments.map(doc => {
    const statusColor = doc.status === 'green' ? '2ECC71' : doc.status === 'amber' ? BRAND_ORANGE : 'FF4757';
    const statusLabel = doc.status === 'green' ? 'Valid' : doc.status === 'amber' ? 'Renewal Due Soon' : doc.status === 'red' ? 'Expired / Invalid' : 'Pending';
    return new TableRow({ children: [
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: doc.doc_name || doc.doc_type_id, bold: true, size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: doc.extracted_value || '—', size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: doc.expiry_date || '—', size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: statusLabel, bold: true, color: statusColor, size: 18 })] })] }),
    ]});
  });

  return [
    new Paragraph({ text: 'Verified Compliance Documents On File', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({ text: 'These certificates have been uploaded and verified through TenderLogix. Physically attach the original or certified copy of each VALID document to your submission — this list confirms what you have on file, it does not replace the physical document.', italics: true, size: 16, color: '888888' })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      new TableRow({ children: ['Document', 'Detail', 'Expiry', 'Status'].map(h => new TableCell({
        shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 18 })] })],
      })) }),
      ...rows,
    ]}),
    new Paragraph({ text: '' }),
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

// MBD 2 — Tax Clearance Certificate Requirements (acknowledgement + action checklist)
function buildMbd2(company) {
  const actions = [
    'Log into SARS e-Filing at www.sars.gov.za',
    'Navigate to "Tax Compliance Status"',
    'Generate and print TCS PIN (active status must show "COMPLIANT")',
    'Attach the TCS PIN printout behind this form',
    'If a consortium/JV is formed, EACH party needs a separate TCS PIN',
  ];
  return [
    ...formHeader('MBD 2', 'TAX CLEARANCE CERTIFICATE REQUIREMENTS'),
    new Paragraph({ children: [new TextRun({ text: 'Original Tax Clearance Certificate is required. Certified copies are NOT acceptable. Valid for 1 year from date of approval.', italics: true, size: 18 })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'ACTION CHECKLIST', bold: true })] }),
    ...actions.map(a => new Paragraph({ children: [new TextRun({ text: '☐  ' + a, size: 18 })] })),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Enterprise', company?.name),
      fieldRow('TCS PIN', null),
      fieldRow('Date Obtained', null),
    ]}),
  ];
}

// MBD 16 — General Conditions of Contract (acknowledgement, no fields to complete)
function buildMbd16() {
  return [
    ...formHeader('MBD 16', 'GENERAL CONDITIONS OF CONTRACT — ACKNOWLEDGEMENT'),
    new Paragraph({ children: [new TextRun({ text: 'By signing the MBD 1 Declaration and the Contract Form (MBD 7.2), the bidder acknowledges acceptance of the General Conditions of Contract as set out in the tender document, including but not limited to:', size: 18 })] }),
    new Paragraph({ text: '' }),
    ...['Definitions', 'Performance Security', 'Inspections, Tests and Analyses', 'Warranty', 'Payment terms', 'Force Majeure', 'Termination', 'Applicable Law: South African law'].map(item =>
      new Paragraph({ children: [new TextRun({ text: '•  ' + item, size: 18 })] })
    ),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'No signature required on this form — acknowledgement is given via the MBD 1 and MBD 7.2 declarations.', italics: true, size: 16, color: '888888' })] }),
  ];
}

// MBD 7.2 — Contract Form (Rendering of Services), Part 1 — Bidder's portion
function buildMbd72(company, report) {
  return [
    ...formHeader('MBD 7.2', 'CONTRACT FORM — RENDERING OF SERVICES (PART 1, BIDDER)'),
    new Paragraph({ children: [new TextRun({ text: '1. I hereby undertake to render the services described in the bidding documents in accordance with the requirements stipulated in bid number ' + (report?.tender_reference || '[bid number]') + ' at the price(s) quoted. My offer remains binding and open for acceptance during the validity period.', size: 18 })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: '2. I confirm I have satisfied myself as to the correctness and validity of my bid; that the price(s) and rate(s) quoted cover all services specified and all my obligations; I accept that mistakes in price(s)/rate(s)/calculations are at my own risk.', size: 18 })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: '3. I accept full responsibility for the proper execution and fulfilment of all obligations under this agreement.', size: 18 })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: '4. I declare no participation in any collusive practices with any bidder regarding this or any other bid.', size: 18 })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: '5. I confirm I am duly authorised to sign this contract.', size: 18 })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Firm', company?.name),
      fieldRow('Name (Print)', null),
      fieldRow('Signature', '_________________ (sign in black ink)'),
      fieldRow('Capacity', null),
      fieldRow('Witness 1', TO_COMPLETE),
      fieldRow('Witness 2', TO_COMPLETE),
      fieldRow('Date', null),
    ]}),
  ];
}

// Category selection — which discipline(s) the bidder is tendering for.
// Pre-checks nothing (we don't reliably know which category the company
// genuinely holds registration for), but lists the rates for quick reference.
function buildCategorySelection() {
  const categories = [
    ['Professional Engineer Technologist', 'ECSA AND NHBRC registration (both required)', 'R4,200.00 per unit'],
    ['Roof Inspector / Roof Engineer', 'ITC-SA accreditation, sanctioned by ECSA', 'R2,100.00 per unit'],
    ['Health & Safety Agent', 'SACPCMP registration (manager or agent)', 'R101.18 per unit'],
    ['Land Surveyor', 'SA Council for Professional and Technical Surveyors', 'R628.00 per site'],
  ];
  return [
    new Paragraph({ text: '', pageBreakBefore: true }),
    new Paragraph({ children: [new TextRun({ text: 'CATEGORY SELECTION', bold: true, size: 28 })] }),
    new Paragraph({ children: [new TextRun({ text: 'Tick ONLY the category/categories for which valid professional registration is held. Submitting for a category without the required certificate results in disqualification for that category.', italics: true, size: 18 })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      new TableRow({ children: ['Tick', 'Category', 'Required Registration', 'Rate'].map(h => new TableCell({
        shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 16 })] })],
      })) }),
      ...categories.map(([name, reg, rate]) => new TableRow({ children: [
        new TableCell({ children: [new Paragraph('☐')] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: name, bold: true, size: 16 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: reg, size: 16 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: rate, size: 16 })] })] }),
      ]})),
    ]}),
  ];
}

// Pricing schedule — the actual form a bidder fills in with their quoted
// rate, alongside the gazetted guideline rate for reference. Distinct from
// the BOQ in the advisory section (that's our analysis; this is the form).
// SBD 3.1 — Pricing Schedule (Firm Prices). National Treasury describes
// this as the most critical form in the pack — it's where the bid is
// actually priced. Renamed/reframed from the earlier generic version to
// match the real SBD 3.1 structure and terminology.
function buildSbd31PricingSchedule(boq) {
  if (!boq || !boq.length) return [];
  const priceableLines = boq.filter(item => item.unit_rate && item.unit_rate > 0);
  return [
    new Paragraph({ text: '', pageBreakBefore: true }),
    ...formHeader('SBD 3.1', 'PRICING SCHEDULE — FIRM PRICES'),
    new Paragraph({ children: [new TextRun({ text: 'This is the most critical form in the bid pack — it is where the price is actually quoted. Complete the "Your Tendered Rate" column. Guideline rates shown are gazetted/benchmark figures for reference only — confirm against the official tender document and SBD 3.1 form included in the tender pack before finalising.', italics: true, size: 18 })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      new TableRow({ children: ['Description', 'Unit', 'Guideline Rate', 'Your Tendered Rate'].map(h => new TableCell({
        shading: { type: ShadingType.SOLID, color: DARK_GRAY, fill: DARK_GRAY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 16 })] })],
      })) }),
      ...priceableLines.map(item => new TableRow({ children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.line_item || '', size: 16 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.unit || '', size: 16 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'R' + item.unit_rate.toLocaleString(), size: 16 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'R __________', size: 16 })] })] }),
      ]})),
    ]}),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Total Bid Price (excl. VAT)', 'R __________'),
      fieldRow('VAT (if registered)', 'R __________'),
      fieldRow('Total Bid Price (incl. VAT)', 'R __________'),
    ]}),
  ];
}

// SBD 6.2 — Local Content Declaration (PPR 2011, Regulation 9). Required
// for designated sectors only — this form genuinely needs a real local
// content % calculation per SATS 1286:2011, which this system cannot
// compute (requires actual supplier cost breakdowns by country of origin).
// Included as a real, honest template flagging that the calculation itself
// must be done manually or by a qualified person — not faked with a guess.
function buildSbd62LocalContent(company) {
  return [
    ...formHeader('SBD 6.2', 'LOCAL CONTENT DECLARATION'),
    new Paragraph({ children: [new TextRun({ text: 'Only applicable if this tender specifies a "designated sector" under the Preferential Procurement Regulations. Check the tender document\'s Special Conditions before completing — if local content is not specified as a requirement, this form is not applicable.', bold: true, color: 'FF4757', size: 18 })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'The local content percentage MUST be calculated using the formula in SATS 1286:2011, based on actual costs and country of origin of all inputs. This calculation cannot be automated by this system — it requires real supplier invoices, cost breakdowns, and exchange rates at the date of bid advertisement. Engage a qualified person (e.g. your accountant or a SARS-registered customs consultant) to complete Annexures C, D, and E before signing this declaration.', italics: true, size: 18 })] }),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name of Bidder', company?.name),
      fieldRow('Designated Sector', TO_COMPLETE),
      fieldRow('Calculated Local Content %', TO_COMPLETE),
      fieldRow('Annexures C, D, E Attached', '☐ YES   ☐ NO'),
    ]}),
    new Paragraph({ text: '' }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Name (Print)', null),
      fieldRow('Signature', '_________________ (sign in black ink)'),
      fieldRow('Capacity', null),
      fieldRow('Date', null),
    ]}),
  ];
}

// Final submission/packaging checklist — envelope endorsement, USB, ink rules.
function buildSubmissionPackaging(report, company) {
  return [
    new Paragraph({ text: '', pageBreakBefore: true }),
    new Paragraph({ children: [new TextRun({ text: 'SUBMISSION & PACKAGING', bold: true, size: 28 })] }),
    new Paragraph({ children: [new TextRun({ text: 'ENVELOPE ENDORSEMENT', bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: 'Write the following on the outside of the sealed envelope:', italics: true, size: 16 })] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      fieldRow('Tender Number', report?.tender_reference),
      fieldRow('Tender Description', report?.tender_title),
      fieldRow('Name of Bidder', company?.name),
    ]}),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: 'FINAL CHECKLIST', bold: true })] }),
    ...[
      'All forms completed in BLACK INK — no Tippex/correction fluid anywhere',
      'Official forms used — not retyped',
      'Scanned copy of entire bid document saved to USB and included in envelope',
      'Envelope sealed and correctly endorsed',
      'Bid validity period (180 days) confirmed and accepted',
    ].map(item => new Paragraph({ children: [new TextRun({ text: '☐  ' + item, size: 18 })] })),
  ];
}


export async function generateProductRunDocx(run, report, company, complianceDocuments) {
  const companyName = company?.name;
  const product = run.product;
  const title = report.tender_title || 'Tender Analysis';
  const ref = report.tender_reference;

  // ── ADVISORY CONTENT — fully TenderLogix branded ──────────────────────
  // Verdict, eligibility, compliance status, BOQ pricing, risk flags. None
  // of this is ever submitted to a tender box — it's our analysis, for the
  // bidder's eyes, and carries the brand throughout (header + footer on
  // every page of this section).
  const advisoryChildren = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'TENDERLOGIX', bold: true, size: 20, color: BRAND_ORANGE, characterSpacing: 40 })],
    }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    ...(ref ? [new Paragraph({ children: [new TextRun({ text: 'Ref: ' + ref, italics: true, color: '666666' })] })] : []),
    new Paragraph({ children: [new TextRun({ text: 'Prepared for: ' + (companyName || ''), color: '666666' })] }),
    new Paragraph({ text: '' }),
  ];

  if (product === 'gonogo' && report.verdict) {
    const verdictColor = report.verdict === 'GO' ? '2ECC71' : report.verdict === 'NO_GO' ? 'FF4757' : BRAND_ORANGE;
    advisoryChildren.push(
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
      advisoryChildren.push(
        new Paragraph({ text: 'Path To Future Tenders', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ children: [new TextRun({ text: report.future_readiness })] }),
      );
    }
  }

  if (product === 'pricing' || product === 'bidpack') {
    if (report.competitive_landscape) {
      advisoryChildren.push(
        new Paragraph({ text: 'Competitive Landscape', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ children: [new TextRun({ text: report.competitive_landscape })] }),
        new Paragraph({ text: '' }),
      );
    }
    advisoryChildren.push(...buildBoqTable(report.boq, report.boq_totals));
    if (report.pricing_disclaimer) {
      advisoryChildren.push(
        new Paragraph({
          children: [new TextRun({ text: report.pricing_disclaimer, italics: true, size: 16, color: '888888' })],
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 8 } },
        }),
      );
    }
  }

  if (product === 'bidpack') {
    advisoryChildren.push(...buildChecklistSection('Compliance Checklist', report.compliance_checklist, 'status', 'item', 'notes'));
    advisoryChildren.push(...buildComplianceDocumentsSection(complianceDocuments));
  }

  const brandedHeader = new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: 'TenderLogix · Analysis & Advisory', size: 14, color: '999999' })],
    })],
  });
  const brandedFooter = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'This page is TenderLogix advisory content — NOT for submission. AI-assisted analysis, verify independently.', size: 13, color: 'AAAAAA' })],
    })],
  });

  const sections = [{
    headers: { default: brandedHeader },
    footers: { default: brandedFooter },
    children: advisoryChildren,
  }];

  // ── OFFICIAL FORMS — Phase 1, completely UNBRANDED ────────────────────
  // A new, separate docx section with NO header/footer at all. These are
  // genuine MBD form layouts intended for actual submission — a third-party
  // logo or "Prepared by TenderLogix" on a government tender form would be
  // inappropriate and could raise questions with the evaluator. This
  // section starts on its own page (new section = automatic page break).
  if (product === 'bidpack') {
    const formsChildren = [
      new Paragraph({ children: [new TextRun({ text: 'OFFICIAL BID FORMS — COMPLETE AND SIGN', bold: true, size: 32, color: BRAND_ORANGE })] }),
      new Paragraph({ children: [new TextRun({ text: 'Fields marked in orange require manual completion — this system does not yet hold this data. Verify every pre-filled field is current before submission.', italics: true, size: 18, color: '888888' })] }),
      new Paragraph({ children: [new TextRun({ text: 'IMPORTANT: National Treasury periodically revises SBD/MBD form layouts (e.g. the 2022 SBD 4 consolidation). These are reference templates reflecting the standard structure — always cross-check against the actual SBD/MBD forms included in this specific tender pack before signing and submitting. Using an outdated form layout can result in disqualification.', bold: true, color: 'FF4757', size: 16 })] }),
      ...buildMbd1(company, report),
      ...buildMbd2(company),
      ...buildMbd4(company),
      ...buildMbd61(company),
      ...buildMbd8(company),
      ...buildMbd9(company, report),
      ...buildMbd15(company),
      ...buildMbd16(),
      ...buildMbd72(company, report),
      ...buildSbd62LocalContent(company),
      ...buildCategorySelection(),
      ...buildSbd31PricingSchedule(report.boq),
      ...buildSubmissionPackaging(report, company),
    ];
    sections.push({
      // No headers/footers key at all — section inherits nothing branded.
      children: formsChildren,
    });
  }

  const doc = new Document({
    sections,
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
