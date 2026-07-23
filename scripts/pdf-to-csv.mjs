// Converts the official BITS Goa timetable PDF into data/timetable.csv, matching the database
// schema. Handles the manual cleanup for you: it skips the title/instruction/legend pages, drops
// the header row repeated on every table page, keeps only the columns we need (renamed to our
// schema), and stitches wrapped cells (titles, instructor lists, two-line dates) back together.
//
// It is layout-agnostic: columns are located by matching the header LABELS (the PDF's wording,
// column order, and two-line headers vary between semesters), not by fixed positions. The tight
// L P U / SEC / STAT cluster is classified by content, so a SEC/STAT column swap doesn't matter.
//
// Usage:  node scripts/pdf-to-csv.mjs <input.pdf> [output.csv]   (output defaults to data/timetable.csv)
// Requires the dev dependency pdfjs-dist:  npm install
//
// Best-effort for a digital-text PDF — always eyeball the diff before committing; the
// "Validate data" check will catch structural problems.

import fs from 'fs';
import Papa from 'papaparse';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'data/timetable.csv';
if (!inputPath) {
  console.error('Usage: node scripts/pdf-to-csv.mjs <input.pdf> [output.csv]');
  process.exit(1);
}

const OUTPUT_COLUMNS = [
  'COURSE NO', 'COURSE TITLE', 'L P U', 'STAT', 'SEC',
  'INSTRUCTOR IN CHARGE/Instructor', 'DAYS/HR', 'ROOM',
  'COMPRE DATE', 'MIDSEM DATE,DAY', 'MIDSEM TIME',
];

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const key = (s) => s.toUpperCase().replace(/\s+/g, '');

// Map a header label to an output field name; null = known but dropped (COM CODE); undefined =
// unknown or ambiguous (e.g. a bare "MID SEM", disambiguated by its "DATE, DAY" / "TIME" sub-label).
function fieldFor(label) {
  const n = key(label);
  if (n.includes('COMCODE')) return null;
  if (n.includes('COURSENO')) return 'COURSE NO';
  if (n.includes('COURSETITLE')) return 'COURSE TITLE';
  if (n === 'LPU' || n.includes('(LPU)')) return 'L P U';
  if (n === 'STAT') return 'STAT';
  if (n === 'SEC') return 'SEC';
  if (n.startsWith('INSTRUCTOR')) return 'INSTRUCTOR IN CHARGE/Instructor';
  if (n.startsWith('DAYS')) return 'DAYS/HR';
  if (n === 'ROOM') return 'ROOM';
  if (n.includes('MIDSEMTIME')) return 'MIDSEM TIME';
  if (n.includes('COMPRE') || n.includes('SLOT')) return 'COMPRE DATE';
  if (n.includes('DATE,DAY')) return 'MIDSEM DATE,DAY';
  if (n === 'TIME') return 'MIDSEM TIME';
  return undefined;
}

// The real table header names several columns on one line — require ≥4 label hits so we don't
// mistake the LEGEND page (which explains "COM CODE", "COURSE NO", … one per line) for the header.
function isHeaderLine(text) {
  const t = key(text);
  const labels = ['COMCODE', 'COURSENO', 'COURSETITLE', 'STAT', 'SEC', 'INSTRUCTOR', 'DAYS', 'ROOM'];
  return labels.filter((l) => t.includes(l)).length >= 4;
}

const hasComcode = (line) => line.tokens.some((t) => /^\d{5,7}$/.test(t.str.trim()));

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
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) r.tokens.sort((a, b) => a.x - b.x);
  return rows;
}

// Build the column layout from the header tokens (both header lines merged): [{x, field}] sorted
// by x, deduped by x-cluster (preferring a named field over the dropped COM CODE).
function buildColumns(headerTokens) {
  const cols = [];
  for (const t of headerTokens) {
    const f = fieldFor(t.str);
    if (f === undefined) continue;
    cols.push({ x: t.x, field: f });
  }
  cols.sort((a, b) => a.x - b.x);
  const merged = [];
  for (const c of cols) {
    const prev = merged[merged.length - 1];
    // Only merge tokens at ~the same x (a two-line header labelling one column, e.g. "COMPRE" +
    // "DATE (SLOT)"). Keep a small threshold so genuinely adjacent columns (e.g. SEC vs
    // INSTRUCTOR, ~16px apart) are NOT merged.
    if (prev && Math.abs(prev.x - c.x) < 6) {
      if (prev.field == null && c.field != null) prev.field = c.field;
      continue;
    }
    merged.push({ ...c });
  }
  return merged;
}

// Header labels can be indented inside wide columns (e.g. a long "INSTRUCTOR IN CHARGE/…" label
// sits well right of where instructor names actually start), so header x-positions make poor
// column boundaries. Instead detect the real column left-edges from the DATA: on a primary
// (record-start) row each cell is a single token, so the recurring token x-positions ARE the
// columns. Returns left-edges in order; the caller maps them to header fields by position.
function detectColumnEdges(primaryLines) {
  const xs = [];
  for (const line of primaryLines) for (const t of line.tokens) xs.push(t.x);
  if (!xs.length) return [];
  xs.sort((a, b) => a - b);
  const GAP = 8;
  const clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.lastX <= GAP) { last.n++; last.lastX = x; if (x < last.x) last.x = x; }
    else clusters.push({ x, lastX: x, n: 1 });
  }
  const minSupport = Math.max(2, Math.floor(primaryLines.length * 0.1));
  return clusters.filter((c) => c.n >= minSupport); // [{x: left-edge, n: support}]
}

// Align detected data edges (ordered x) to the header columns (ordered {x, field}) monotonically,
// minimising total x-distance. Edges are a subsequence of the columns (a page may lack data for
// some columns, e.g. lab rows have no Room/Compre/Midsem), so this figures out which field each
// detected edge is — even when a header label is indented (INSTRUCTOR) — via order, not proximity
// alone. Returns the field for each edge (edges.length must be ≤ cols.length).
function alignEdgesToFields(edges, cols) {
  const n = edges.length, m = cols.length, INF = 1e9;
  const dp = Array.from({ length: n }, () => new Array(m).fill(INF));
  const back = Array.from({ length: n }, () => new Array(m).fill(-1));
  for (let j = 0; j < m; j++) dp[0][j] = Math.abs(edges[0] - cols[j].x);
  for (let i = 1; i < n; i++) {
    let bestPrev = INF, bestJ = -1;
    for (let j = 0; j < m; j++) {
      if (j > 0 && dp[i - 1][j - 1] < bestPrev) { bestPrev = dp[i - 1][j - 1]; bestJ = j - 1; }
      if (bestPrev < INF) { dp[i][j] = bestPrev + Math.abs(edges[i] - cols[j].x); back[i][j] = bestJ; }
    }
  }
  let end = -1, best = INF;
  for (let j = 0; j < m; j++) if (dp[n - 1][j] < best) { best = dp[n - 1][j]; end = j; }
  const out = new Array(n);
  let j = end;
  for (let i = n - 1; i >= 0; i--) { out[i] = cols[j].field; j = back[i][j]; }
  return out;
}

// Which column index does a token at x belong to? (midpoints between column anchors)
function columnOf(x, cols) {
  for (let i = 0; i < cols.length - 1; i++) {
    if (x < (cols[i].x + cols[i + 1].x) / 2) return i;
  }
  return cols.length - 1;
}

// Re-derive L P U / SEC / STAT from their combined tokens by CONTENT, so column order (STAT/SEC
// swap between layouts) and tight-spacing misfiling don't matter.
function reparseCluster(tokens) {
  let stat = '', lpu = '', sec = '';
  const nums = [];
  for (const t of tokens) {
    const s = t.str.trim();
    if (!s) continue;
    if (/^[A-Za-z]$/.test(s)) stat = stat || s;                 // single letter → STAT
    else nums.push({ x: t.x, s });
  }
  nums.sort((a, b) => a.x - b.x);
  // L P U looks like credits (a number group like "3 0 3", or a starred value); else leftmost number.
  let lpuTok = nums.find((t) => /\d\s\d/.test(t.s) || t.s.includes('*')) || nums[0];
  if (lpuTok) {
    lpu = lpuTok.s;
    sec = nums.filter((t) => t !== lpuTok).map((t) => t.s).join(' ').trim();
  }
  return { lpu, sec, stat };
}

function finalize(cur, fieldIdx) {
  const out = {};
  for (const f of OUTPUT_COLUMNS) {
    const i = fieldIdx[f];
    out[f] = i != null ? norm(cur[i].map((t) => t.str).join(' ')) : '';
  }
  const clusterTokens = [];
  for (const f of ['L P U', 'SEC', 'STAT']) {
    const i = fieldIdx[f];
    if (i != null) clusterTokens.push(...cur[i]);
  }
  if (clusterTokens.length) {
    const r = reparseCluster(clusterTokens);
    out['L P U'] = r.lpu;
    out['SEC'] = r.sec;
    out['STAT'] = r.stat;
  }
  return out;
}

async function run() {
  const data = new Uint8Array(fs.readFileSync(inputPath));
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  // Pass 1: collect every table page's lines (and where its data starts), the header (columns are
  // identical on every page, so the first one suffices), and all primary/data rows.
  const pages = [];
  let headerTokens = null;
  const allPrimary = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = toLines(content.items);

    const headerIdx = lines.findIndex((l) => isHeaderLine(l.tokens.map((t) => t.str).join(' ')));
    if (headerIdx === -1) continue; // instruction / legend / title page

    // Merge the header line with any following label-only lines (a wrapped second header row)
    // until the first data row (which carries a COM CODE number).
    const ht = [...lines[headerIdx].tokens];
    let start = headerIdx + 1;
    while (
      start < lines.length &&
      !hasComcode(lines[start]) &&
      !isHeaderLine(lines[start].tokens.map((t) => t.str).join(' '))
    ) {
      ht.push(...lines[start].tokens);
      start++;
    }
    if (!headerTokens) headerTokens = ht;

    for (let i = start; i < lines.length; i++) if (hasComcode(lines[i])) allPrimary.push(lines[i]);
    pages.push({ lines, start });
  }

  if (!headerTokens) {
    fs.writeFileSync(outputPath, Papa.unparse({ fields: OUTPUT_COLUMNS, data: [] }) + '\n');
    console.log('Parsed 0 table page(s) → 0 rows.');
    console.log(`Wrote ${outputPath}`);
    return;
  }

  // Build ONE global column layout: header gives the field order; the data's actual column
  // left-edges (detected across all pages, so they're stable) re-anchor them — fixing indented
  // header labels and column-order differences between PDF layouts.
  const cols = buildColumns(headerTokens);
  let clusters = detectColumnEdges(allPrimary);
  if (clusters.length > cols.length) clusters = [...clusters].sort((a, b) => b.n - a.n).slice(0, cols.length);
  clusters.sort((a, b) => a.x - b.x);
  const edges = clusters.map((c) => c.x);
  if (edges.length) {
    const fields = alignEdgesToFields(edges, cols);
    const xByField = new Map();
    edges.forEach((x, i) => xByField.set(fields[i], x));
    for (const c of cols) if (xByField.has(c.field)) c.x = xByField.get(c.field);
  }

  const fieldIdx = {};
  cols.forEach((c, i) => { if (c.field) fieldIdx[c.field] = i; });
  const cnIdx = fieldIdx['COURSE NO'];
  if (cnIdx == null) {
    console.error('Could not locate the COURSE NO column in the header.');
    process.exit(1);
  }

  // Pass 2: parse records on every page with the global layout.
  const rows = [];
  for (const { lines, start } of pages) {
    const recs = [];  // course rows (anchored by a COURSE NO): { y, lines: [{y, assigned}] }
    const conts = []; // wrapped/continuation lines: { y, assigned }
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (isHeaderLine(line.tokens.map((t) => t.str).join(' '))) continue;

      const assigned = cols.map(() => []);
      for (const t of line.tokens) assigned[columnOf(t.x, cols)].push(t);

      const cn = assigned[cnIdx].map((t) => t.str).join(' ').trim();
      if (/^[A-Z]{2,6}\s?[A-Z]?[0-9]{3}/i.test(cn)) recs.push({ y: line.y, lines: [{ y: line.y, assigned }] });
      else conts.push({ y: line.y, assigned });
    }

    // Attach each wrapped line to a course row. Most cells (instructor lists, dates) wrap
    // DOWNWARD, so they belong to the row just ABOVE (reading order) — attaching them there keeps
    // long instructor lists from bleeding across the tight rows of a dense multi-section block.
    // Only the TITLE can be centred on the comcode row (its first line sits above its own row),
    // so a title-only line goes to the vertically nearest row (with a small bias to "above" so a
    // normal downward title wrap still stays put).
    const titleIdx = fieldIdx['COURSE TITLE'];
    const BIAS = 4;
    for (const c of conts) {
      let above = null, below = null;
      for (const r of recs) {
        if (r.y >= c.y) { if (!above || r.y < above.y) above = r; }
        else if (!below || r.y > below.y) below = r;
      }
      const used = new Set();
      c.assigned.forEach((toks, k) => { if (toks.length) used.add(k); });
      const titleOnly = used.size > 0 && [...used].every((k) => k === titleIdx);

      let target = above || below;
      if (titleOnly && above && below && Math.abs(c.y - below.y) < Math.abs(c.y - above.y) - BIAS) {
        target = below;
      }
      if (target) target.lines.push(c);
    }

    for (const r of recs) {
      r.lines.sort((a, b) => b.y - a.y); // top → bottom, so wrapped cells read in order
      const perCol = cols.map(() => []);
      for (const ln of r.lines) for (let k = 0; k < cols.length; k++) perCol[k].push(...ln.assigned[k]);
      const obj = finalize(perCol, fieldIdx);
      if (obj['COURSE NO']) rows.push(obj);
    }
  }

  const csv = Papa.unparse({ fields: OUTPUT_COLUMNS, data: rows }, { newline: '\n' });
  fs.writeFileSync(outputPath, csv + '\n');

  console.log(`Parsed ${pages.length} table page(s) → ${rows.length} rows.`);
  console.log(`Wrote ${outputPath}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
