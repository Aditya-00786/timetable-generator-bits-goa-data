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

// Re-derive L P U / SEC / STAT from their combined tokens: the lone letter is STAT (so a STAT/SEC
// column-order swap between layouts doesn't matter). SEC is always a SINGLE section number, so when
// several numbers are present we take the ONE nearest the SEC column as SEC and give the rest to
// L P U — this beats a per-token nearest-column vote, which misfiles a single-number L P U value
// (e.g. a thesis "16") that sits between the two columns and drifts to SEC, yielding "16 1". With
// only one number (or no column anchors) we fall back to nearest-column / a credits-like heuristic.
function reparseCluster(tokens, lpuX, secX) {
  let stat = '';
  const nums = [];
  for (const t of tokens) {
    const s = t.str.trim();
    if (!s) continue;
    if (/^[A-Za-z]$/.test(s)) { if (!stat) stat = s; continue; }
    nums.push(t);
  }
  const lpu = [], sec = [];
  if (secX != null && nums.length > 1) {
    let si = 0;
    for (let i = 1; i < nums.length; i++) if (Math.abs(nums[i].x - secX) < Math.abs(nums[si].x - secX)) si = i;
    nums.forEach((t, i) => (i === si ? sec : lpu).push(t));
  } else if (lpuX != null && secX != null) {
    for (const t of nums) (Math.abs(t.x - lpuX) <= Math.abs(t.x - secX) ? lpu : sec).push(t);
  } else {
    for (const t of nums) ((/\d\s\d/.test(t.str) || t.str.includes('*')) ? lpu : sec).push(t); // no anchors: credits-like → L P U
  }
  const join = (a) => a.sort((x, y) => x.x - y.x).map((t) => t.str.trim()).join(' ');
  return { lpu: join(lpu), sec: join(sec), stat };
}

// From line `i`, walk in one vertical direction (step -1 = up, +1 = down) and return the index of
// the first course-row (anchor) reached — but stop (return -1) if a gap larger than `threshold`
// intervenes. A course's own lines are a contiguous chain of small gaps down to its comcode row,
// while the boundary between courses is a larger gap: so this connects a wrapped line to the
// course it truly belongs to, no matter how many lines its title spans, and a big gap blocks it
// from bleeding into the neighbouring course.
function reachAnchor(items, i, step, threshold) {
  let j = i;
  for (;;) {
    const k = j + step;
    if (k < 0 || k >= items.length) return -1;
    if (Math.abs(items[j].y - items[k].y) > threshold) return -1;
    if (items[k].isAnchor) return k;
    j = k;
  }
}

function finalize(cur, fieldIdx, cols) {
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
    const lpuI = fieldIdx['L P U'], secI = fieldIdx['SEC'];
    const r = reparseCluster(clusterTokens, lpuI != null ? cols[lpuI].x : null, secI != null ? cols[secI].x : null);
    out['L P U'] = r.lpu;
    out['SEC'] = r.sec;
    out['STAT'] = r.stat;
  }
  return out;
}

// Detect the semester from the PDF's own title text — e.g. "SECOND SEMESTER 2025-2026" -> "2025-S2"
// (S1 = first/odd, S2 = second/even; the year is the academic year's start). Title digits are often
// separate text items, so we match on the space-stripped text. Returns null if not found.
function detectSemesterFromText(text) {
  const t = text.toUpperCase().replace(/\s+/g, '');
  let m = t.match(/(FIRST|SECOND)SEMESTER(20\d\d)[-–—/](20\d\d)/);
  if (m) return `${m[2]}-${m[1] === 'SECOND' ? 'S2' : 'S1'}`;
  m = t.match(/SEMESTER(I{1,2})(20\d\d)[-–—/](20\d\d)/); // "SEMESTER II 2025-2026" order
  if (m) return `${m[2]}-${m[1] === 'II' ? 'S2' : 'S1'}`;
  return null;
}

async function run() {
  const data = new Uint8Array(fs.readFileSync(inputPath));
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  // Pass 1: collect every table page's lines (and where its data starts), the header (columns are
  // identical on every page, so the first one suffices), and all primary/data rows.
  const pages = [];
  let headerTokens = null;
  const allPrimary = [];
  let docText = '';

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    docText += ' ' + content.items.map((it) => it.str).join(' ');
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

  const detectedSemester = detectSemesterFromText(docText);
  if (detectedSemester) console.log(`Detected semester (from title): ${detectedSemester}`);

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
  const titleIdx = fieldIdx['COURSE TITLE'];

  // Detect how titles wrap, once, globally — it flips how an ambiguous title-only line is resolved
  // (see the title-only branch below). In a DOWNWARD-wrapping layout the title starts on the comcode
  // row and spills to the lines below, so almost every record row carries its own title. A CENTRED
  // layout floats a multi-line title above AND below the comcode row, leaving many record rows with
  // no title of their own. The fraction of record rows that carry a title separates the two cleanly.
  let titledRows = 0;
  for (const pl of allPrimary) {
    const asg = cols.map(() => []);
    for (const t of pl.tokens) asg[columnOf(t.x, cols)].push(t);
    if (titleIdx != null && asg[titleIdx].length) titledRows++;
  }
  const downwardWrap = allPrimary.length > 0 && titledRows / allPrimary.length >= 0.9;

  // Pass 2: parse records on every page with the global layout.
  const rows = [];
  for (const { lines, start } of pages) {
    // Turn the page's data lines into items (course rows + wrapped lines), top → bottom.
    const items = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (isHeaderLine(line.tokens.map((t) => t.str).join(' '))) continue;
      const assigned = cols.map(() => []);
      for (const t of line.tokens) assigned[columnOf(t.x, cols)].push(t);
      const cn = assigned[cnIdx].map((t) => t.str).join(' ').trim();
      const isAnchor = /^[A-Z]{2,6}\s?[A-Z]?[0-9]{3}/i.test(cn);
      const used = new Set();
      assigned.forEach((toks, k) => { if (toks.length) used.add(k); });
      const titleOnly = !isAnchor && used.size > 0 && [...used].every((k) => k === titleIdx);
      items.push({ y: line.y, assigned, isAnchor, titleOnly });
    }
    if (!items.length) continue;

    // A gap noticeably bigger than the usual line spacing marks a course boundary.
    const gaps = [];
    for (let i = 0; i < items.length - 1; i++) { const g = Math.abs(items[i].y - items[i + 1].y); if (g > 0) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 10;
    const threshold = median * 1.3;

    const recByIdx = new Map();
    const order = [];
    items.forEach((it, idx) => { if (it.isAnchor) { const rec = { lines: [it] }; recByIdx.set(idx, rec); order.push(rec); } });

    items.forEach((it, idx) => {
      if (it.isAnchor) return;

      let target = -1;
      if (it.titleOnly) {
        // A wrapped title line belongs to a course row REACHABLE through small gaps (contiguity); a
        // big gap blocks bleeding to a neighbour. HOW to pick between the reachable course above and
        // below depends on the layout (detected globally above):
        //
        //  • DOWNWARD-wrap: a title spills onto the lines BELOW its comcode row and can span several
        //    lines, so a late continuation line drifts closer to the next course. Decide per whole
        //    contiguous BLOCK of continuation lines (any non-anchor lines — title-only or a mixed
        //    line also carrying a wrapped date/instructor, which anchors the block to its record)
        //    and attach by the block's nearest EDGE, so the whole title stays with one course.
        //  • CENTRED: a multi-line title floats above AND below its comcode row, so consecutive
        //    title-only lines belong to DIFFERENT courses; decide per line by nearest anchor.
        let up, down, distUp, distDown;
        if (downwardWrap) {
          let top = idx, bottom = idx;
          while (top - 1 >= 0 && !items[top - 1].isAnchor && Math.abs(items[top].y - items[top - 1].y) <= threshold) top--;
          while (bottom + 1 < items.length && !items[bottom + 1].isAnchor && Math.abs(items[bottom].y - items[bottom + 1].y) <= threshold) bottom++;
          up = reachAnchor(items, top, -1, threshold);
          down = reachAnchor(items, bottom, +1, threshold);
          distUp = up >= 0 ? Math.abs(items[top].y - items[up].y) : Infinity;
          distDown = down >= 0 ? Math.abs(items[bottom].y - items[down].y) : Infinity;
        } else {
          up = reachAnchor(items, idx, -1, threshold);
          down = reachAnchor(items, idx, +1, threshold);
          distUp = up >= 0 ? Math.abs(it.y - items[up].y) : Infinity;
          distDown = down >= 0 ? Math.abs(it.y - items[down].y) : Infinity;
        }
        if (up >= 0 && down >= 0) target = distUp <= distDown ? up : down;
        else if (up >= 0) target = up;
        else if (down >= 0) target = down;
        else { let bd = Infinity; items.forEach((a, ai) => { if (a.isAnchor) { const d = Math.abs(it.y - a.y); if (d < bd) { bd = d; target = ai; } } }); }
      } else {
        // Instructor lists / dates wrap downward — attach to the course row just above.
        for (let k = idx - 1; k >= 0; k--) if (items[k].isAnchor) { target = k; break; }
        if (target < 0) for (let k = idx + 1; k < items.length; k++) if (items[k].isAnchor) { target = k; break; }
      }
      if (target >= 0 && recByIdx.has(target)) recByIdx.get(target).lines.push(it);
    });

    for (const rec of order) {
      rec.lines.sort((a, b) => b.y - a.y); // top → bottom, so wrapped cells read in order
      const perCol = cols.map(() => []);
      for (const ln of rec.lines) for (let k = 0; k < cols.length; k++) perCol[k].push(...ln.assigned[k]);
      const obj = finalize(perCol, fieldIdx, cols);
      if (obj['COURSE NO']) rows.push(obj);
    }
  }

  // Occasionally a title is rendered twice in the source (or two sections' identical titles get
  // merged onto one row through an odd line gap), yielding "X X". Collapse an exact self-repeat.
  const dedupTitle = (t) => {
    const s = norm(t);
    if (s.length % 2 === 1) {
      const h = (s.length - 1) / 2; // index of the middle char
      if (s[h] === ' ' && s.slice(0, h) === s.slice(h + 1)) return s.slice(0, h);
    }
    return t;
  };
  for (const r of rows) r['COURSE TITLE'] = dedupTitle(r['COURSE TITLE']);

  // Some layouts print a course's title only once (not on every section row), leaving other
  // sections' titles blank. Fill a blank title from another section of the same course.
  const titleByCourse = new Map();
  for (const r of rows) { const cn = r['COURSE NO']; if (r['COURSE TITLE'] && !titleByCourse.has(cn)) titleByCourse.set(cn, r['COURSE TITLE']); }
  for (const r of rows) { if (!r['COURSE TITLE'] && titleByCourse.has(r['COURSE NO'])) r['COURSE TITLE'] = titleByCourse.get(r['COURSE NO']); }

  const csv = Papa.unparse({ fields: OUTPUT_COLUMNS, data: rows }, { newline: '\n' });
  fs.writeFileSync(outputPath, csv + '\n');

  console.log(`Parsed ${pages.length} table page(s) → ${rows.length} rows.`);
  console.log(`Wrote ${outputPath}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
