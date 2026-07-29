// Phase 2: normalize an Adobe-exported timetable XLSX into data/timetable.csv's exact schema.
//
// Adobe's table extraction is clean but varies between PDFs: header names differ
// (COMCODE/COM CO, COURSE NO/COURSENO, L P U/CREDIT L P U, DAYS/HR/DAYS/ H), the STAT and SEC
// columns are sometimes swapped, and the page banner + per-page header rows are interleaved with
// data. So we map columns by FUZZY HEADER NAME (never by position), and treat any row whose
// computer-code cell is a 5-6 digit number as a data row (which skips banners and repeated headers).
//
// Usage: node scripts/xlsx-to-timetable-csv.mjs <in.xlsx> <out.csv>

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';

// The exact output columns validate-data.mjs / the sync step expect.
const OUT_HEADERS = [
  'COURSE NO', 'COURSE TITLE', 'L P U', 'STAT', 'SEC',
  'INSTRUCTOR IN CHARGE/Instructor', 'DAYS/HR', 'ROOM',
  'COMPRE DATE', 'MIDSEM DATE,DAY', 'MIDSEM TIME',
];

const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Map one raw header string to a canonical field key (or null if unrecognized).
const canonOf = (h) => {
  const n = norm(h);
  if (!n) return null;
  if (n.includes('COURSETITLE')) return 'TITLE';
  if (n.includes('COURSENO')) return 'NO';
  if (n.includes('COMCODE') || n.startsWith('COMCO')) return 'COMCODE';
  if (n.includes('LPU')) return 'LPU';
  if (n.includes('INSTRUCTOR')) return 'INSTRUCTOR';
  // Days/hours column: "DAYS/H" in older layouts, "SCHEDULE" in newer ones. Exclude COMPRE so the
  // "COMPRE SCHEDULE" (compre date) column isn't captured here — it's handled by the COMPRE rule.
  if (n.includes('DAYS') || (n.includes('SCHEDULE') && !n.includes('COMPRE'))) return 'DAYS';
  if (n.includes('ROOM')) return 'ROOM';
  if (n.includes('MIDSEM') && n.includes('TIME')) return 'MIDSEM_TIME';
  if (n.includes('MIDSEM') && n.includes('DATE')) return 'MIDSEM_DATE';
  if (n.includes('COMPRE')) return 'COMPRE';
  if (n === 'STAT') return 'STAT';
  if (n === 'SEC') return 'SEC';
  return null;
};

// COURSE NO: dept + code, code may end in a letter and/or carry a "-N" suffix.
//   BIO F101, CS F372, BITS C790T, BITS F101-1
// Collapse an exact "X X" self-repeat (a title occasionally rendered/merged twice) → "X".
const dedupTitle = (t) => {
  const s = (t || '').replace(/\s+/g, ' ').trim();
  if (s.length % 2 === 1) {
    const h = (s.length - 1) / 2;
    if (s[h] === ' ' && s.slice(0, h) === s.slice(h + 1)) return s.slice(0, h);
  }
  return t;
};

const COURSE_NO_RE = /^[A-Z]{2,5}\s?[A-Z]?\d{3}[A-Z]?(?:-\d+)?$/;
const COMCODE_RE = /^\d{5,6}$/;
// STAT is a short letter code: L/T/P (schedulable) plus R (thesis/independent study), I, etc.
// A 1-2 letter token — rejects LPU/title fragments (e.g. "3 0 3") that leak in on a bad extraction.
const STAT_RE = /^[A-Z]{1,2}$/;

// Flatten a cell to text but PRESERVE internal newlines — Adobe emits one line per component in a
// vertically-merged DAYS/HR cell, and we need those breaks to split it back apart (see below).
const cellRaw = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v.hyperlink != null) return String(v.text ?? v.hyperlink);
    return '';
  }
  return String(v);
};

// Collapse to a single clean line (used for every field except while splitting DAYS/HR).
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

const readRows = async (xlsxPath) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => { cells[cell.col - 1] = cellRaw(cell.value); });
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    rows.push(cells);
  });
  return rows;
};

// Find the header row and build { field: columnIndex }. The header row is the first that maps a
// course-no column plus the L/P/U and STAT/SEC columns.
const buildColumnMap = (rows) => {
  for (let r = 0; r < rows.length; r++) {
    const map = {};
    rows[r].forEach((cell, i) => {
      const c = canonOf(cell);
      if (c && !(c in map)) map[c] = i;
    });
    if ('NO' in map && 'LPU' in map && 'STAT' in map && 'SEC' in map) {
      return { map, headerRow: r };
    }
  }
  return null;
};

const normalize = async (xlsxPath) => {
  const rows = await readRows(xlsxPath);
  const found = buildColumnMap(rows);
  if (!found) throw new Error('Could not locate a header row (need COURSE NO + L P U + STAT + SEC columns).');
  const { map, headerRow } = found;

  const at = (row, field) => (map[field] != null ? (row[map[field]] || '') : ''); // raw (may hold \n)
  const cln = (row, field) => clean(at(row, field));
  // A data row has either a numeric computer code OR a course-number-shaped COURSE NO. Checking both
  // (not COMCODE alone) keeps rows where Adobe failed to read the code (e.g. "#N/A"), while still
  // excluding the banner and repeated-header rows (neither cell matches).
  const isDataRow = (row) =>
    COMCODE_RE.test(cln(row, 'COMCODE')) || COURSE_NO_RE.test(cln(row, 'NO').toUpperCase());

  const anomalies = [];
  const recs = [];
  let lastNo = '', lastTitle = '', lastLpu = '';

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!isDataRow(row)) continue;

    let courseNo = cln(row, 'NO').toUpperCase();
    let title = cln(row, 'TITLE');
    let lpu = cln(row, 'LPU');
    // Carry down course identity if a section row left it blank (defensive; not seen so far).
    if (!courseNo && (cln(row, 'STAT') || cln(row, 'SEC'))) { courseNo = lastNo; title = title || lastTitle; lpu = lpu || lastLpu; }
    if (courseNo) { lastNo = courseNo; lastTitle = title; lastLpu = lpu; }

    const stat = cln(row, 'STAT').toUpperCase();
    const sec = cln(row, 'SEC');

    if (!COURSE_NO_RE.test(courseNo)) { anomalies.push(`row ${r + 1}: bad COURSE NO "${courseNo}"`); continue; }
    if (!STAT_RE.test(stat)) { anomalies.push(`row ${r + 1}: bad STAT "${stat}" (${courseNo})`); continue; }
    if (!sec) { anomalies.push(`row ${r + 1}: empty SEC (${courseNo} ${stat})`); continue; }

    recs.push({
      courseNo, title: dedupTitle(title), lpu, stat, sec,
      instructor: cln(row, 'INSTRUCTOR'),
      daysRaw: at(row, 'DAYS'), // keep newlines — needed for the merge split below
      room: cln(row, 'ROOM'),
      compre: cln(row, 'COMPRE'), midDate: cln(row, 'MIDSEM_DATE'), midTime: cln(row, 'MIDSEM_TIME'),
    });
  }

  // Un-merge Adobe's vertically-merged DAYS/HR. When a course's DAYS/HR wraps across lines (one line
  // per component), Adobe sometimes stamps that whole multi-line cell onto every component row of the
  // course — so each component wrongly claims all the slots and clashes with its siblings. Detect a
  // run of consecutive rows of the SAME course sharing an identical multi-line cell; if its line
  // count equals the run length, hand line k back to component-row k. Otherwise leave it collapsed.
  let daysSplit = 0;
  for (let i = 0; i < recs.length;) {
    let j = i;
    while (j + 1 < recs.length && recs[j + 1].courseNo === recs[i].courseNo && recs[j + 1].daysRaw === recs[i].daysRaw) j++;
    const runLen = j - i + 1;
    const lines = recs[i].daysRaw.split('\n').map(clean).filter(Boolean);
    if (runLen > 1 && recs[i].daysRaw.includes('\n') && lines.length === runLen) {
      for (let k = 0; k < runLen; k++) recs[i + k].days = lines[k];
      daysSplit += runLen;
    } else {
      for (let k = 0; k < runLen; k++) recs[i + k].days = clean(recs[i + k].daysRaw);
    }
    i = j + 1;
  }

  const out = recs.map((rec) => [
    rec.courseNo, rec.title, rec.lpu, rec.stat, rec.sec,
    rec.instructor, rec.days, rec.room, rec.compre, rec.midDate, rec.midTime,
  ]);

  // Backfill a blank title from another section of the same course (some layouts print the title
  // only on the first section row). Column 0 = COURSE NO, column 1 = COURSE TITLE.
  const titleByCourse = new Map();
  for (const r of out) if (r[1] && !titleByCourse.has(r[0])) titleByCourse.set(r[0], r[1]);
  let backfilled = 0;
  for (const r of out) if (!r[1] && titleByCourse.has(r[0])) { r[1] = titleByCourse.get(r[0]); backfilled++; }

  return { out, map, headerRow, anomalies, backfilled, daysSplit, totalRows: rows.length };
};

const main = async () => {
  const [input, outArg] = process.argv.slice(2);
  if (!input) { console.error('Usage: node scripts/xlsx-to-timetable-csv.mjs <in.xlsx> [out.csv]'); process.exit(1); }
  const outPath = path.resolve(outArg || 'data/timetable.csv');

  const { out, map, headerRow, anomalies, daysSplit, totalRows } = await normalize(path.resolve(input));

  const csv = Papa.unparse({ fields: OUT_HEADERS, data: out }, { quotes: false });
  fs.writeFileSync(outPath, csv + '\n');

  console.log(`Input: ${path.resolve(input)}`);
  console.log(`Header row: ${headerRow + 1}  |  column map: ${JSON.stringify(map)}`);
  console.log(`Scanned ${totalRows} rows → ${out.length} data rows → ${outPath}`);
  if (daysSplit) console.log(`Split ${daysSplit} merged DAYS/HR row(s) back to their components.`);
  if (anomalies.length) {
    console.log(`\n⚠ ${anomalies.length} row(s) skipped as anomalies:`);
    anomalies.slice(0, 20).forEach((a) => console.log(`   - ${a}`));
    if (anomalies.length > 20) console.log(`   … and ${anomalies.length - 20} more`);
  } else {
    console.log('No anomalies. ✅');
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
}

export { normalize, canonOf, OUT_HEADERS };
