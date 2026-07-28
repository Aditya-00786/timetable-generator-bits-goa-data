// Phase 1 of the Adobe-based conversion pipeline: PDF -> Excel (via Adobe PDF Services) -> a raw
// CSV dump for inspection. This does NOT yet produce data/timetable.csv — it just surfaces exactly
// what Adobe's table extraction gives us, so the normalizer (phase 2) can be built against the real
// structure. Runs identically locally (.env) and in CI (Actions secrets); reads creds from env.
//
// Usage:
//   node scripts/adobe-convert.mjs <input.pdf> [out.xlsx] [out.csv]
//   PAGES=3-45 node scripts/adobe-convert.mjs <input.pdf>   # only send these pages to Adobe
//
// PAGES accepts 1-based ranges/lists: "3-45", "3-" (to end), "1,2,5", or a mix "3-10,15,20-".

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import {
  ServicePrincipalCredentials, PDFServices, MimeType,
  ExportPDFParams, ExportPDFTargetFormat, ExportPDFJob, ExportPDFResult,
} from '@adobe/pdfservices-node-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// --- minimal .env loader (no dependency); does not overwrite already-set env vars ---
const loadEnv = () => {
  const f = path.join(REPO, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
};

// Resolve a PAGES spec against a total page count -> sorted unique 1-based page numbers.
const parsePages = (spec, total) => {
  const out = new Set();
  for (const partRaw of spec.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)\s*-\s*(\d*)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : total;
      for (let p = start; p <= Math.min(end, total); p++) if (p >= 1) out.add(p);
    } else if (/^\d+$/.test(part)) {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= total) out.add(p);
    } else {
      throw new Error(`Bad PAGES segment: "${part}"`);
    }
  }
  return [...out].sort((a, b) => a - b);
};

// Return a PDF buffer trimmed to the requested pages (or the original bytes if no PAGES set).
const trimPdf = async (bytes, spec) => {
  if (!spec) return bytes;
  const src = await PDFDocument.load(bytes);
  const pages = parsePages(spec, src.getPageCount());
  if (pages.length === 0) throw new Error(`PAGES="${spec}" selected no pages (doc has ${src.getPageCount()}).`);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages.map(p => p - 1)); // pdf-lib is 0-based
  copied.forEach(pg => out.addPage(pg));
  console.log(`Trimmed to ${pages.length} page(s): ${spec} -> [${pages.join(', ')}]`);
  return Buffer.from(await out.save());
};

// Flatten any exceljs cell value (rich text runs, hyperlinks, formula results, dates) to plain
// text, collapsing intra-cell newlines/whitespace so a wrapped title lands on one line.
export const cellText = (v) => {
  if (v == null) return '';
  let s;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) s = v.richText.map((r) => r.text).join('');
    else if (v.text != null) s = String(v.text);
    else if (v.result != null) s = String(v.result);
    else if (v.hyperlink != null) s = String(v.text ?? v.hyperlink);
    else s = '';
  } else {
    s = String(v);
  }
  return s.replace(/\s+/g, ' ').trim();
};

const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// Dump every sheet/row/cell to one CSV (plain text), sheets separated by a marker, for inspection.
const dumpXlsxToCsv = async (xlsxPath, csvPath) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const lines = [];
  wb.eachSheet((ws) => {
    lines.push(`# === Sheet: ${ws.name} (${ws.rowCount} rows x ${ws.columnCount} cols) ===`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell) => vals.push(cellText(cell.value)));
      lines.push(vals.map(csvCell).join(','));
    });
    lines.push('');
  });
  fs.writeFileSync(csvPath, lines.join('\n'));
  return wb;
};

// Send a PDF (optionally trimmed to `pages`) through Adobe's Export → XLSX and write the result to
// `outXlsx`. Reusable by the end-to-end pipeline. Reads creds from env (.env locally / CI secrets).
export const exportPdfToXlsx = async ({ pdfBytes, pages, outXlsx }) => {
  loadEnv();
  const clientId = process.env.PDF_SERVICES_CLIENT_ID;
  const clientSecret = process.env.PDF_SERVICES_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing PDF_SERVICES_CLIENT_ID / PDF_SERVICES_CLIENT_SECRET (set them in .env or as env vars).');
  }
  const trimmed = await trimPdf(pdfBytes, pages);

  const credentials = new ServicePrincipalCredentials({ clientId, clientSecret });
  const pdfServices = new PDFServices({ credentials });

  console.log('Uploading to Adobe PDF Services…');
  const { Readable } = await import('stream');
  const inputAsset = await pdfServices.upload({ readStream: Readable.from(trimmed), mimeType: MimeType.PDF });

  console.log('Submitting Export → XLSX job…');
  const params = new ExportPDFParams({ targetFormat: ExportPDFTargetFormat.XLSX });
  const job = new ExportPDFJob({ inputAsset, params });
  const pollingURL = await pdfServices.submit({ job });
  const response = await pdfServices.getJobResult({ pollingURL, resultType: ExportPDFResult });

  console.log('Downloading result…');
  const streamAsset = await pdfServices.getContent({ asset: response.result.asset });
  fs.mkdirSync(path.dirname(outXlsx), { recursive: true });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outXlsx);
    streamAsset.readStream.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
  });
  return outXlsx;
};

const main = async () => {
  loadEnv();
  const [input, outXlsxArg, outCsvArg] = process.argv.slice(2);
  if (!input) {
    console.error('Usage: node scripts/adobe-convert.mjs <input.pdf> [out.xlsx] [out.csv]');
    process.exit(1);
  }
  const artifactsDir = path.join(REPO, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const outXlsx = path.resolve(outXlsxArg || path.join(artifactsDir, 'timetable.xlsx'));
  const outCsv = path.resolve(outCsvArg || path.join(artifactsDir, 'raw.csv'));

  console.log(`Input PDF: ${path.resolve(input)}`);
  await exportPdfToXlsx({ pdfBytes: fs.readFileSync(path.resolve(input)), pages: process.env.PAGES, outXlsx });
  console.log(`Wrote XLSX → ${outXlsx}`);

  const wb = await dumpXlsxToCsv(outXlsx, outCsv);
  console.log(`Wrote raw CSV → ${outCsv}`);
  console.log('\nSheets:');
  wb.eachSheet((ws) => console.log(`  - ${ws.name}: ${ws.rowCount} rows x ${ws.columnCount} cols`));
};

// Only run when invoked directly (so helpers like cellText can be imported without side effects).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
}
