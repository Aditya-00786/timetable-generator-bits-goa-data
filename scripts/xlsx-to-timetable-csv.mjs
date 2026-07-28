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
import { cellText } from './adobe-convert.mjs';

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
  if (n.includes('DAYS')) return 'DAYS';
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

const readRows = async (xlsxPath) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => { cells[cell.col - 1] = cellText(cell.value); });
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

  const at = (row, field) => (map[field] != null ? (row[map[field]] || '').trim() : '');
  // A data row has either a numeric computer code OR a course-number-shaped COURSE NO. Checking both
  // (not COMCODE alone) keeps rows where Adobe failed to read the code (e.g. "#N/A"), while still
  // excluding the banner and repeated-header rows (neither cell matches).
  const isDataRow = (row) =>
    COMCODE_RE.test(at(row, 'COMCODE')) || COURSE_NO_RE.test(at(row, 'NO').toUpperCase().replace(/\s+/g, ' '));

  const out = [];
  const anomalies = [];
  let lastNo = '', lastTitle = '', lastLpu = '';

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!isDataRow(row)) continue;

    let courseNo = at(row, 'NO').toUpperCase().replace(/\s+/g, ' ');
    let title = at(row, 'TITLE');
    let lpu = at(row, 'LPU');
    // Carry down course identity if a section row left it blank (defensive; not seen so far).
    if (!courseNo && (at(row, 'STAT') || at(row, 'SEC'))) { courseNo = lastNo; title = title || lastTitle; lpu = lpu || lastLpu; }
    if (courseNo) { lastNo = courseNo; lastTitle = title; lastLpu = lpu; }

    const stat = at(row, 'STAT').toUpperCase();
    const sec = at(row, 'SEC');

    if (!COURSE_NO_RE.test(courseNo)) { anomalies.push(`row ${r + 1}: bad COURSE NO "${courseNo}"`); continue; }
    if (!STAT_RE.test(stat)) { anomalies.push(`row ${r + 1}: bad STAT "${stat}" (${courseNo})`); continue; }
    if (!sec) { anomalies.push(`row ${r + 1}: empty SEC (${courseNo} ${stat})`); continue; }

    out.push([
      courseNo, dedupTitle(title), lpu, stat, sec,
      at(row, 'INSTRUCTOR'), at(row, 'DAYS'), at(row, 'ROOM'),
      at(row, 'COMPRE'), at(row, 'MIDSEM_DATE'), at(row, 'MIDSEM_TIME'),
    ]);
  }

  // Backfill a blank title from another section of the same course (some layouts print the title
  // only on the first section row). Column 0 = COURSE NO, column 1 = COURSE TITLE.
  const titleByCourse = new Map();
  for (const r of out) if (r[1] && !titleByCourse.has(r[0])) titleByCourse.set(r[0], r[1]);
  let backfilled = 0;
  for (const r of out) if (!r[1] && titleByCourse.has(r[0])) { r[1] = titleByCourse.get(r[0]); backfilled++; }

  return { out, map, headerRow, anomalies, backfilled, totalRows: rows.length };
};

const main = async () => {
  const [input, outArg] = process.argv.slice(2);
  if (!input) { console.error('Usage: node scripts/xlsx-to-timetable-csv.mjs <in.xlsx> [out.csv]'); process.exit(1); }
  const outPath = path.resolve(outArg || 'data/timetable.csv');

  const { out, map, headerRow, anomalies, totalRows } = await normalize(path.resolve(input));

  const csv = Papa.unparse({ fields: OUT_HEADERS, data: out }, { quotes: false });
  fs.writeFileSync(outPath, csv + '\n');

  console.log(`Input: ${path.resolve(input)}`);
  console.log(`Header row: ${headerRow + 1}  |  column map: ${JSON.stringify(map)}`);
  console.log(`Scanned ${totalRows} rows → ${out.length} data rows → ${outPath}`);
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
