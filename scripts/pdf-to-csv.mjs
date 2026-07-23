// Converts the official BITS Goa timetable PDF into data/timetable.csv, matching the database
// schema. Handles everything you'd otherwise do by hand: it skips the title/instruction/legend
// pages, drops the header row repeated on every table page, keeps only the columns we need,
// renames them to our schema, and stitches wrapped cells (titles, instructor lists, dates that
// span two lines) back together.
//
// Usage:  node scripts/pdf-to-csv.mjs <input.pdf> [output.csv]
//         (output defaults to data/timetable.csv)
//
// Requires the dev dependency pdfjs-dist:  npm install
//
// It's a best-effort parser for a digital-text PDF — always eyeball the diff before committing.
// The "Validate data" check will catch structural problems.

import fs from 'fs';
import Papa from 'papaparse';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'data/timetable.csv';

if (!inputPath) {
  console.error('Usage: node scripts/pdf-to-csv.mjs <input.pdf> [output.csv]');
  process.exit(1);
}

// The 12 columns in the PDF, left→right. `null` = present in the PDF but dropped (not in our
// schema). The rest are the exact target header names in data/timetable.csv.
const COLUMN_SCHEMA = [
  null,                                // COMCODE
  'COURSE NO',
  'COURSE TITLE',
  'L P U',
  'STAT',
  'SEC',
  'INSTRUCTOR IN CHARGE/Instructor',
  'DAYS/HR',                           // PDF: "DAYS/ H"
  'ROOM',
  'COMPRE DATE',                       // PDF: "COMPRE DATE (SLOT)"
  'MIDSEM DATE,DAY',                   // PDF: "MID SEM DATE, DAY"
  'MIDSEM TIME',                       // PDF: "MID SEM TIME"
];
const OUTPUT_COLUMNS = COLUMN_SCHEMA.filter(Boolean);

// Fallback column x-anchors, used only if we can't derive them from a page's header row.
const FALLBACK_ANCHORS = [20, 65, 127, 253, 273, 293, 309, 564, 623, 669, 724, 773];

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// A line is the table header if it names the leading columns.
function isHeaderLine(text) {
  const t = norm(text).toUpperCase();
  return t.includes('COMCODE') || (t.includes('COURSE NO') && t.includes('STAT') && t.includes('SEC'));
}

// Group a page's text items into visual lines (by y), each sorted left→right by x.
function toLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= 3);
    if (!row) { row = { y, tokens: [] }; rows.push(row); }
    row.tokens.push({ x, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // top → bottom
  for (const r of rows) r.tokens.sort((a, b) => a.x - b.x);
  return rows;
}

// Derive the 12 column x-anchors from a header line's token positions; fall back if unexpected.
function deriveAnchors(headerTokens) {
  const xs = headerTokens.map((t) => t.x).sort((a, b) => a - b);
  return xs.length === COLUMN_SCHEMA.length ? xs : FALLBACK_ANCHORS;
}

// Which column (index) does a token at position x belong to? Uses midpoints between anchors.
function columnFor(x, anchors) {
  for (let i = 0; i < anchors.length - 1; i++) {
    if (x < (anchors[i] + anchors[i + 1]) / 2) return i;
  }
  return anchors.length - 1;
}

// Split one visual line's tokens into per-column arrays of strings.
function splitByColumn(tokens, anchors) {
  const cols = {};
  for (const t of tokens) {
    const i = columnFor(t.x, anchors);
    (cols[i] ||= []).push(t.str);
  }
  return cols;
}

function mergeInto(record, cols) {
  for (const [i, strs] of Object.entries(cols)) {
    const piece = norm(strs.join(' '));
    if (!piece) continue;
    record[i] = record[i] ? `${record[i]} ${piece}` : piece;
  }
}

async function run() {
  const data = new Uint8Array(fs.readFileSync(inputPath));
  // verbosity: 0 (errors only) silences harmless "standardFontDataUrl"/font warnings — we only
  // read text positions, never render glyphs.
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  const records = [];
  let pagesWithTable = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = toLines(content.items);

    // Find the header on this page. Pages without one (title, calendar, legend, handout) are
    // instruction pages → skipped entirely.
    const headerIdx = lines.findIndex((l) => isHeaderLine(l.tokens.map((t) => t.str).join(' ')));
    if (headerIdx === -1) continue;
    pagesWithTable++;

    const anchors = deriveAnchors(lines[headerIdx].tokens);
    let cur = null;

    // Everything above the header (page title) is ignored; start just after it. Any further
    // header-like line (shouldn't happen mid-page) is skipped too.
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const text = line.tokens.map((t) => t.str).join(' ');
      if (isHeaderLine(text)) continue;

      const cols = splitByColumn(line.tokens, anchors);
      // A new record starts on the line that carries a COURSE NO (column 1). We key on the
      // course-code pattern rather than the COMCODE, because a few courses (e.g. BITS F317)
      // have no COMCODE and would otherwise be merged into the previous record. Wrapped
      // continuation lines never reach column 1, so they aren't mistaken for record starts.
      const courseNo = (cols[1] || []).join(' ').trim();
      const isRecordStart = /^[A-Z]{2,6}\s+[A-Z]?\d{3}/i.test(courseNo);

      if (isRecordStart) {
        if (cur) records.push(cur);
        cur = {};
        mergeInto(cur, cols);
      } else if (cur) {
        mergeInto(cur, cols); // wrapped continuation of the current record
      }
      // (lines before the first record on a page — e.g. the "DATE (SLOT)" header sub-row — fall
      //  through here with cur === null and are ignored)
    }
    if (cur) { records.push(cur); cur = null; }
  }

  // Map the positional records to our schema objects (dropping the COMCODE column).
  const rows = records.map((rec) => {
    // The L P U / STAT / SEC columns sit only ~20px apart, so x-boundaries misfile digits
    // (e.g. STAT reads "3 R"). Re-derive them by content from the combined cluster:
    // "<L P U> <STAT> <SEC>" → e.g. "0 0 3 R 1", "3* L 1", "2 1 3 L 1".
    const cluster = norm([rec[3], rec[4], rec[5]].filter(Boolean).join(' '));
    const m = cluster.match(/^([\d\s*]*?)\s*([A-Za-z])\s*(\d+)?\s*$/);
    if (m) { rec[3] = m[1].trim(); rec[4] = m[2]; rec[5] = m[3] || ''; }

    const out = {};
    for (let i = 0; i < COLUMN_SCHEMA.length; i++) {
      const name = COLUMN_SCHEMA[i];
      if (!name) continue;
      out[name] = norm(rec[i] || '');
    }
    return out;
  }).filter((r) => r['COURSE NO']); // drop any stray empty record

  const csv = Papa.unparse({ fields: OUTPUT_COLUMNS, data: rows }, { newline: '\n' });
  fs.writeFileSync(outputPath, csv + '\n');

  console.log(`Parsed ${pagesWithTable} table page(s) → ${rows.length} rows.`);
  console.log(`Wrote ${outputPath}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
