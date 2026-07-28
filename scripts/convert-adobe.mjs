// End-to-end Adobe conversion: PDF → data/timetable.csv.
//
//   detect table pages (drop front/back matter) → Adobe Export XLSX → normalize to schema →
//   validate → write CSV.
//
// Usage:
//   node scripts/convert-adobe.mjs <input.pdf> [out.csv]     # out.csv defaults to data/timetable.csv
//   PAGES=6-32 node scripts/convert-adobe.mjs <input.pdf>    # override auto page-detection
//
// Prints "Detected semester: YYYY-Sx" so a workflow can pick up the semester from the PDF.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Papa from 'papaparse';
import { exportPdfToXlsx } from './adobe-convert.mjs';
import { normalize, OUT_HEADERS } from './xlsx-to-timetable-csv.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const getDoc = async (pdfBytes) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
};

// Table pages carry many rows, each starting with a 6-digit computer code; front/back matter has
// none. Return the inclusive [first..last] page range that has ≥3 such codes (so sparse interior
// pages between them are still kept). Returns null if no table page is found.
export const detectTablePages = async (pdfBytes) => {
  const doc = await getDoc(pdfBytes);
  const hits = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const txt = (await (await doc.getPage(p)).getTextContent()).items.map((i) => i.str).join(' ');
    if ((txt.match(/\b\d{6}\b/g) || []).length >= 3) hits.push(p);
  }
  if (hits.length === 0) return null;
  return { start: hits[0], end: hits[hits.length - 1], total: doc.numPages };
};

// Semester from the title page: "… SECOND SEMESTER 2025 – 2026" → "2025-S2".
export const detectSemester = async (pdfBytes) => {
  const doc = await getDoc(pdfBytes);
  const first = (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  const flat = first.replace(/\s+/g, '').toUpperCase();
  const ord = flat.includes('FIRSTSEMESTER') ? 'S1'
    : flat.includes('SECONDSEMESTER') ? 'S2'
    : flat.includes('SUMMERTERM') || flat.includes('SUMMERSEMESTER') ? 'ST' : null;
  const year = (flat.match(/SEMESTER(20\d{2})/) || flat.match(/(20\d{2})/) || [])[1];
  return ord && year ? `${year}-${ord}` : null;
};

const main = async () => {
  const [input, outArg] = process.argv.slice(2);
  if (!input) { console.error('Usage: node scripts/convert-adobe.mjs <input.pdf> [out.csv]'); process.exit(1); }

  const pdfBytes = fs.readFileSync(path.resolve(input));
  console.log(`Input PDF: ${path.resolve(input)}`);

  // Page range: explicit PAGES wins; otherwise auto-detect the table block.
  let pages = process.env.PAGES;
  if (!pages) {
    const det = await detectTablePages(pdfBytes);
    if (!det) { console.error('Could not detect any table pages (no page had ≥3 six-digit codes).'); process.exit(1); }
    pages = `${det.start}-${det.end}`;
    console.log(`Auto-detected table pages: ${pages} (of ${det.total})`);
  } else {
    console.log(`Using PAGES override: ${pages}`);
  }

  const semester = await detectSemester(pdfBytes).catch(() => null);
  if (semester) console.log(`Detected semester: ${semester}`);

  const tmpXlsx = path.join(REPO, 'artifacts', '_convert.xlsx');
  await exportPdfToXlsx({ pdfBytes, pages, outXlsx: tmpXlsx });

  const { out, anomalies, map, daysSplit } = await normalize(tmpXlsx);
  console.log(`Column map: ${JSON.stringify(map)}`);
  if (daysSplit) console.log(`Split ${daysSplit} merged DAYS/HR row(s) back to their components.`);

  const outCsv = path.resolve(outArg || path.join(REPO, 'data', 'timetable.csv'));
  fs.writeFileSync(outCsv, Papa.unparse({ fields: OUT_HEADERS, data: out }) + '\n');
  console.log(`Wrote ${out.length} rows → ${outCsv}`);

  // Final gate: non-empty, and every row well-formed (mirrors validate-data.mjs expectations).
  const problems = [];
  if (out.length === 0) problems.push('no data rows produced');
  const badStat = out.filter((r) => !/^[A-Z]{1,2}$/.test((r[3] || '').trim())).length;
  const badNo = out.filter((r) => !(r[0] || '').trim()).length;
  if (badStat) problems.push(`${badStat} row(s) with a malformed STAT`);
  if (badNo) problems.push(`${badNo} row(s) with an empty COURSE NO`);
  if (anomalies.length) console.log(`Note: ${anomalies.length} source row(s) skipped as anomalies.`);

  if (problems.length) { console.error(`\nVALIDATION FAILED: ${problems.join('; ')}`); process.exit(1); }
  console.log('Validation passed. ✅');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
}
