import fs from 'fs';
import Papa from 'papaparse';

// Validates the CSV data files against the schema documented in data/README.md, so contributors
// get instant feedback on a PR (this runs WITHOUT any secrets). It does NOT touch the database.
// Run locally with: npm run validate

const SPECS = {
  'data/timetable.csv': {
    required: true,
    headers: [
      'COURSE NO', 'COURSE TITLE', 'L P U', 'STAT', 'SEC',
      'INSTRUCTOR IN CHARGE/Instructor', 'DAYS/HR', 'ROOM',
      'COMPRE DATE', 'MIDSEM DATE,DAY', 'MIDSEM TIME',
    ],
  },
  'data/midsem.csv': {
    required: false,
    headers: ['COURSE NO', 'COURSE TITLE', 'MIDSEM DATE,DAY', 'MIDSEM TIME'],
  },
  'data/compre.csv': {
    required: false,
    headers: ['COURSE NO', 'COURSE TITLE', 'COMPRE DATE,DAY', 'COMPRE TIME'],
  },
};

let failed = false;
const fail = (m) => { console.error(`✖ ${m}`); failed = true; };
const pass = (m) => console.log(`✔ ${m}`);
const skip = (m) => console.log(`• ${m}`);

// semester.txt
if (!fs.existsSync('data/semester.txt')) {
  fail('data/semester.txt is missing.');
} else {
  const sem = fs.readFileSync('data/semester.txt', 'utf8').trim();
  if (!sem) fail('data/semester.txt is empty.');
  else pass(`data/semester.txt = "${sem}"`);
}

for (const [file, spec] of Object.entries(SPECS)) {
  if (!fs.existsSync(file)) {
    if (spec.required) fail(`${file} is required but missing.`);
    else skip(`${file} not present (optional) — skipped.`);
    continue;
  }

  const content = fs.readFileSync(file, 'utf8');
  const { data, errors, meta } = Papa.parse(content, { header: true, skipEmptyLines: true });

  if (errors.length) {
    const e = errors[0];
    fail(`${file}: ${errors.length} parse error(s). First — row ${e.row}: ${e.message}`);
    continue;
  }

  const fields = meta.fields || [];
  const missing = spec.headers.filter((h) => !fields.includes(h));
  if (missing.length) {
    fail(`${file}: missing required column(s): ${missing.map((m) => `"${m}"`).join(', ')}`);
    continue;
  }

  if (fields.includes('id')) {
    fail(`${file}: remove the "id" column — Supabase generates it automatically.`);
    continue;
  }

  if (spec.required && data.length === 0) {
    fail(`${file}: has no data rows.`);
    continue;
  }

  // SEC must be a plain integer — the DB column is a bigint, so a stray letter (e.g. a source-PDF
  // typo like SEC="P") would otherwise pass here and only blow up later at the Supabase import.
  if (fields.includes('SEC')) {
    const badSec = data
      .map((row, i) => ({ i, sec: (row.SEC ?? '').toString().trim(), course: row['COURSE NO'], stat: row.STAT }))
      .filter((r) => !/^\d+$/.test(r.sec));
    if (badSec.length) {
      const sample = badSec.slice(0, 5).map((r) => `row ${r.i + 2} ${r.course || ''} ${r.stat || ''} SEC="${r.sec}"`).join('; ');
      fail(`${file}: ${badSec.length} row(s) with a non-numeric SEC — ${sample}${badSec.length > 5 ? '; …' : ''}`);
      continue;
    }
  }

  pass(`${file}: ${data.length} row(s), all required columns present.`);
}

if (failed) {
  console.error('\nData validation failed. Please fix the issues above and push again.');
  process.exit(1);
}
console.log('\nAll data files are valid. ✅');
