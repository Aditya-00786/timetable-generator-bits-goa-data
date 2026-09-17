// Converts an official BITS Goa exam-schedule PDF (mid-semester or comprehensive) into
// data/midsem.csv / data/compre.csv, matching the override schemas in data/README.md.
//
// These PDFs are laid out as one ruled table repeated over every page, with a header row on
// each. Compared with the main timetable PDF the table is simple — one text item per cell — so
// the work here is mostly *normalisation*, because the source is inconsistent between semesters
// and even between rows:
//
//   - Header wording varies: "MIDSEM DATE" vs "MIDSEM DATE,DAY" vs "MID SEM DATE & DAY".
//   - Extra columns appear that we don't store (e.g. "INSTRUCTOR IN CHARGE (Prof.)"), so any
//     column we don't recognise is dropped rather than treated as an error.
//   - The date cell mixes separators and day spellings ("10/10/2026,Saturday" vs
//     "03/10/2026, Saturday"), and sometimes carries a parenthetical note.
//   - Courses with no exam say "NO MID SEM"; undecided ones say "TBA".
//   - A course number can wrap across two lines ("BITS F463/ BITS" + "U463"), as can titles.
//
// Everything above is reconciled to the conventions already present in data/timetable.csv:
// dates as "DD/MM/YYYY, Ddd", times as "HH:MM AM - HH:MM PM", "TBA" preserved, "no exam" as an
// empty cell.
//
// Usage:  node scripts/exam-pdf-to-csv.mjs <input.pdf> [output.csv] [--kind=midsem|compre]
//         (kind is auto-detected from the table header, the PDF title, then the filename;
//          output defaults to data/<kind>.csv)
// Requires the dev dependency pdfjs-dist:  npm install
//
// Best-effort for a digital-text PDF. It prints a report of everything it normalised or could
// not parse — read that, and eyeball the diff, before committing.

import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const inputPath = positional[0];
const kindFlag = (flags.find((f) => f.startsWith('--kind=')) || '').split('=')[1]?.toLowerCase() || null;

if (!inputPath) {
  console.error('Usage: node scripts/exam-pdf-to-csv.mjs <input.pdf> [output.csv] [--kind=midsem|compre]');
  process.exit(1);
}
if (kindFlag && kindFlag !== 'midsem' && kindFlag !== 'compre') {
  console.error(`Invalid --kind="${kindFlag}" — expected "midsem" or "compre".`);
  process.exit(1);
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
// Collapse a label to letters+digits only, so header matching survives spacing and punctuation
// differences ("MIDSEM DATE,DAY" / "MID SEM DATE & DAY" both become MIDSEMDATEDAY).
const key = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const pad2 = (n) => String(n).padStart(2, '0');

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Internal field names. DATE/TIME are kind-agnostic here and are renamed on output, so the same
// parser serves both the midsem and compre PDFs.
const FIELDS = ['COURSE NO', 'COURSE TITLE', 'DATE', 'TIME'];

// Map a header label to an internal field. `undefined` means "column we don't store" — the
// instructor column, a COM CODE, a remarks column — and is dropped silently by design.
function fieldFor(label) {
  const n = key(label);
  if (!n) return undefined;
  if (n.includes('COURSENO') || n.includes('COURSECODE') || n === 'COURSE') return 'COURSE NO';
  if (n.includes('COURSETITLE') || n.includes('COURSENAME') || n === 'TITLE') return 'COURSE TITLE';
  if (n.includes('TIME')) return 'TIME';   // before DATE: a "DATE" test would not match TIME anyway,
  if (n.includes('DATE')) return 'DATE';   // but this keeps the intent explicit if wording changes.
  return undefined;
}

// The header is the row naming the course column plus at least one exam column. Requiring three
// recognised labels keeps a stray data row from being mistaken for it.
function isHeaderLine(tokens) {
  const fields = tokens.map((t) => fieldFor(t.str)).filter(Boolean);
  return fields.includes('COURSE NO') && (fields.includes('DATE') || fields.includes('TIME')) && fields.length >= 3;
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
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) r.tokens.sort((a, b) => a.x - b.x);
  return rows;
}

// Column left-edges come straight from the header tokens: in these PDFs every cell starts at its
// column's edge, so header x positions are the boundaries. A few points of tolerance absorbs
// cells whose text begins with a stray space (" PLANT PHYSIOLOGY" renders ~2px right, and the
// occasional cell sits a hair left of its label).
const X_TOL = 6;
function columnOf(x, cols) {
  let best = null;
  for (const c of cols) if (x >= c.x - X_TOL && (!best || c.x > best.x)) best = c;
  return best;
}

// A course-number cell is finished unless it trails a "/" or ends on a bare department prefix —
// both mean the code wrapped onto the next line ("BITS F463/ BITS" → "U463", "MATH U428/" →
// "MATH F428"). This is what tells a continuation line apart from the next record.
function courseNoComplete(text) {
  const t = norm(text);
  if (!t) return false;
  if (t.endsWith('/')) return false;
  return /\d/.test(t.split(/\s+/).pop());
}

// "Mid Semester Exam - Semester I 2026-27" → "2026-S1". Used only to warn when the PDF's semester
// disagrees with data/semester.txt; the timetable converter owns that file.
function detectSemesterFromText(text) {
  const t = text.toUpperCase().replace(/\s+/g, '');
  let m = t.match(/(FIRST|SECOND)SEMESTER(20\d\d)[-–—/](?:20)?\d\d/);
  if (m) return `${m[2]}-${m[1] === 'SECOND' ? 'S2' : 'S1'}`;
  m = t.match(/SEMESTER(I{1,2})(20\d\d)[-–—/](?:20)?\d\d/);
  if (m) return `${m[2]}-${m[1] === 'II' ? 'S2' : 'S1'}`;
  return null;
}

function detectKind(headerLabels, docText, filename) {
  const fromHeader = key(headerLabels.join(' '));
  if (fromHeader.includes('COMPRE')) return 'compre';
  if (fromHeader.includes('MIDSEM')) return 'midsem';
  const t = key(docText);
  if (t.includes('COMPREHENSIVE') || t.includes('COMPRE')) return 'compre';
  if (t.includes('MIDSEMESTER') || t.includes('MIDSEM')) return 'midsem';
  const f = key(filename);
  if (f.includes('COMPRE')) return 'compre';
  if (f.includes('MIDSEM')) return 'midsem';
  return null;
}

// --- Cell normalisation ------------------------------------------------------------------

function normalizeCourseNo(raw) {
  const t = norm(raw);
  if (!t) return '';
  // Cross-listed codes are kept in one cell, separated by "/ " — the form data/README.md
  // documents and the app splits on (e.g. "ECOM F342/ CS F342").
  return t.split('/').map((p) => norm(p)).filter(Boolean).join('/ ');
}

function normalizeTitle(raw, report, course) {
  const t = norm(raw);
  const cleaned = t.replace(/[`´'"]+$/, '').trim();
  if (cleaned !== t) report.titleFixes.push({ course, from: t, to: cleaned });
  return cleaned;
}

// Compre schedules often give the session rather than clock times — "14/12/2026 (FN)" — and
// data/timetable.csv stores compre dates in exactly that form. It is a value, not an aside, so it
// is pulled out before notes are stripped and handed to the time column (see normalizeExamCells).
function extractSession(text) {
  const m = text.match(/\((\s*(?:FN|AN|FORENOON|AFTERNOON)\s*)\)/i);
  if (!m) return { session: null, rest: text };
  const word = m[1].trim().toUpperCase();
  const session = word.startsWith('F') ? 'FN' : 'AN';
  return { session, rest: text.replace(m[0], ' ') };
}

function normalizeDate(raw, report, course) {
  const original = norm(raw);
  if (!original) return '';

  // Lift any parenthetical aside out of the cell ("… (No mid sem for RMIT students)"): the schema
  // has nowhere to put it, and leaving it in would break date parsing downstream.
  const asides = [];
  let s = norm(original.replace(/\(([^)]*)\)/g, (_, n) => { asides.push(norm(n)); return ' '; }));
  if (asides.length) report.droppedNotes.push({ course, note: asides.join('; '), raw: original });

  if (/^TBA\b/i.test(s)) return 'TBA';          // TBA is a real value in timetable.csv — keep it.
  // "NO MID SEM" / "NO COMPRE" / "NO EXAM": the course has no exam. Emitted as an empty cell,
  // which is how data/timetable.csv already represents it (the literal never appears there).
  if (/^NO(MIDSEM|MIDSEMESTER|COMPRE|COMPREHENSIVE|EXAM)/.test(key(s))) {
    report.noExam.push(course);
    return '';
  }

  const m = s.match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/);
  if (!m) {
    report.unparsedDates.push({ course, raw: original });
    return s; // keep the raw text so the reviewer sees it in the diff rather than losing it
  }

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  const d = new Date(yyyy, mm - 1, dd);
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) {
    report.unparsedDates.push({ course, raw: original, why: 'not a real calendar date' });
    return s;
  }

  const computed = DAY_ABBR[d.getDay()];
  const stated = s.match(/\b(SUN|MON|TUE|WED|THU|FRI|SAT)[A-Z]*\b/i);
  let day = computed;
  if (stated) {
    const abbr = stated[1][0].toUpperCase() + stated[1].slice(1, 3).toLowerCase();
    // A disagreement means the source has a typo in either the date or the weekday. Keep what the
    // PDF says and flag it — we can't tell which half is wrong, and guessing would hide the error.
    if (abbr !== computed) report.dayMismatch.push({ course, raw: original, stated: abbr, computed });
    day = abbr;
  }
  return `${pad2(dd)}/${pad2(mm)}/${yyyy}, ${day}`;
}

function normalizeTime(raw, report, course) {
  const original = norm(raw);
  if (!original) return '';
  // "BETWEEN 04:00 PM - 07:00 PM" → "04:00 PM - 07:00 PM" (the form already in timetable.csv).
  let s = original.replace(/^BETWEEN\s+/i, '');
  const m = s.match(/(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?\s*(?:-|–|—|TO)\s*(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?/i);
  if (!m) {
    report.unparsedTimes.push({ course, raw: original });
    return s;
  }
  const out = `${pad2(m[1])}:${m[2]} ${m[3].toUpperCase()}M - ${pad2(m[4])}:${m[5]} ${m[6].toUpperCase()}M`;
  if (out !== original) report.timeFixes.push({ course, from: original, to: out });
  return out;
}

// Normalise the date and time cells together, because an "(FN)"/"(AN)" session marker is written
// in the date cell but belongs with the time. It is never discarded: if the row has no clock
// times it becomes the time value, otherwise it is reported so the mismatch gets a human look.
function normalizeExamCells(rawDate, rawTime, report, course) {
  const { session, rest } = extractSession(norm(rawDate));
  const date = normalizeDate(rest, report, course);
  const time = normalizeTime(rawTime, report, course);
  if (!session) return { date, time };
  if (!time) {
    report.sessions.push({ course, session });
    return { date, time: `(${session})` };
  }
  report.sessionConflicts.push({ course, session, time });
  return { date, time };
}

// --- Main --------------------------------------------------------------------------------

async function run() {
  const data = new Uint8Array(fs.readFileSync(inputPath));
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  const report = {
    noExam: [], droppedNotes: [], dayMismatch: [], unparsedDates: [],
    unparsedTimes: [], timeFixes: [], titleFixes: [], sessions: [], sessionConflicts: [],
  };

  let cols = null;
  let headerLabels = [];
  let docText = '';
  let tablePages = 0;
  const records = [];
  let cur = null;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    docText += ' ' + content.items.map((it) => it.str).join(' ');
    const lines = toLines(content.items);

    const headerIdx = lines.findIndex((l) => isHeaderLine(l.tokens));
    if (headerIdx === -1) continue; // cover / instructions / notes page

    // Column positions are identical on every page, so the first header defines the layout.
    if (!cols) {
      cols = lines[headerIdx].tokens
        .map((t) => ({ x: t.x, field: fieldFor(t.str), label: norm(t.str) }))
        .sort((a, b) => a.x - b.x);
      headerLabels = cols.map((c) => c.label);
    }
    tablePages++;

    // A record ends where the next one begins, so a page break does not close one: keep `cur`
    // across pages for the (rare) row whose cells straddle the boundary.
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const cells = Object.fromEntries(FIELDS.map((f) => [f, []]));
      let any = false;
      for (const tok of lines[i].tokens) {
        const col = columnOf(tok.x, cols);
        if (!col || !col.field) continue; // a column we don't store
        cells[col.field].push(tok.str);
        any = true;
      }
      if (!any) continue;

      const startsNew = cells['COURSE NO'].length > 0
        && (!cur || courseNoComplete(cur['COURSE NO'].join(' ')));
      if (startsNew) {
        cur = Object.fromEntries(FIELDS.map((f) => [f, []]));
        records.push(cur);
      }
      if (!cur) continue; // text above the first record (a stray title line)
      for (const f of FIELDS) cur[f].push(...cells[f]);
    }
  }

  if (!cols) {
    console.error(`No exam table found in ${inputPath} — is this the right PDF?`);
    process.exit(1);
  }

  const kind = kindFlag || detectKind(headerLabels, docText, path.basename(inputPath));
  if (!kind) {
    console.error('Could not tell whether this is a midsem or compre schedule. Re-run with --kind=midsem or --kind=compre.');
    process.exit(1);
  }
  const DATE_COL = kind === 'compre' ? 'COMPRE DATE,DAY' : 'MIDSEM DATE,DAY';
  const TIME_COL = kind === 'compre' ? 'COMPRE TIME' : 'MIDSEM TIME';
  const OUTPUT_COLUMNS = ['COURSE NO', 'COURSE TITLE', DATE_COL, TIME_COL];
  const outputPath = positional[1] || `data/${kind}.csv`;

  const rows = [];
  for (const rec of records) {
    const course = normalizeCourseNo(rec['COURSE NO'].join(' '));
    if (!course) continue;
    const { date, time } = normalizeExamCells(rec.DATE.join(' '), rec.TIME.join(' '), report, course);
    rows.push({
      'COURSE NO': course,
      'COURSE TITLE': normalizeTitle(rec['COURSE TITLE'].join(' '), report, course),
      [DATE_COL]: date,
      [TIME_COL]: time,
    });
  }

  const csv = Papa.unparse({ fields: OUTPUT_COLUMNS, data: rows }, { newline: '\n' });
  fs.writeFileSync(outputPath, csv + '\n');

  // --- Report ---------------------------------------------------------------------------
  const ignored = cols.filter((c) => !c.field).map((c) => `"${c.label}"`);
  console.log(`Detected: ${kind} schedule — ${tablePages} table page(s) → ${rows.length} rows.`);
  if (ignored.length) console.log(`Ignored column(s): ${ignored.join(', ')}`);
  console.log(`Columns: ${OUTPUT_COLUMNS.map((c) => `"${c}"`).join(', ')}`);

  const semester = detectSemesterFromText(docText);
  if (semester) {
    const current = fs.existsSync('data/semester.txt')
      ? fs.readFileSync('data/semester.txt', 'utf8').trim() : '';
    console.log(`Detected semester (from title): ${semester}`);
    if (current && current !== semester) {
      console.warn(`  ⚠ data/semester.txt says "${current}" — check you are converting the right PDF.`);
    }
  }

  const withDate = rows.filter((r) => r[DATE_COL] && r[DATE_COL] !== 'TBA').length;
  console.log(`  ${withDate} scheduled, ${rows.filter((r) => r[DATE_COL] === 'TBA').length} TBA, ${report.noExam.length} with no exam (empty date).`);

  const list = (items, n = 8) => items.slice(0, n).join('; ') + (items.length > n ? `; …(+${items.length - n})` : '');
  if (report.noExam.length) console.log(`  No exam: ${list(report.noExam)}`);
  if (report.sessions.length) {
    const fn = report.sessions.filter((s) => s.session === 'FN').length;
    console.log(`  Session markers moved from the date to the time column: ${fn} (FN), ${report.sessions.length - fn} (AN).`);
  }
  if (report.sessionConflicts.length) {
    console.warn('  ⚠ Row has BOTH a session marker and clock times — kept the times, dropped the marker:');
    for (const s of report.sessionConflicts) console.warn(`      ${s.course}: (${s.session}) vs "${s.time}"`);
  }
  if (report.timeFixes.length) console.log(`  Times normalised: ${list(report.timeFixes.map((f) => `${f.course} "${f.from}"→"${f.to}"`))}`);
  if (report.titleFixes.length) console.log(`  Titles cleaned: ${list(report.titleFixes.map((f) => `${f.course} "${f.from}"→"${f.to}"`))}`);
  if (report.droppedNotes.length) {
    console.warn('  ⚠ Notes dropped from the date cell (no column for them) — check none matter:');
    for (const d of report.droppedNotes) console.warn(`      ${d.course}: "${d.note}"  (raw: "${d.raw}")`);
  }
  if (report.dayMismatch.length) {
    console.warn('  ⚠ Weekday disagrees with the date (source typo — kept the PDF\'s weekday):');
    for (const d of report.dayMismatch) console.warn(`      ${d.course}: "${d.raw}" says ${d.stated}, that date is a ${d.computed}`);
  }
  if (report.unparsedDates.length) {
    console.warn('  ⚠ Unrecognised date(s), passed through verbatim — fix by hand:');
    for (const d of report.unparsedDates) console.warn(`      ${d.course}: "${d.raw}"${d.why ? ` (${d.why})` : ''}`);
  }
  if (report.unparsedTimes.length) {
    console.warn('  ⚠ Unrecognised time(s), passed through verbatim — fix by hand:');
    for (const d of report.unparsedTimes) console.warn(`      ${d.course}: "${d.raw}"`);
  }

  const seen = new Map();
  for (const r of rows) seen.set(r['COURSE NO'], (seen.get(r['COURSE NO']) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([c, n]) => `${c} ×${n}`);
  if (dupes.length) console.warn(`  ⚠ Duplicate course number(s): ${list(dupes)}`);

  const halfFilled = rows.filter((r) => (!!r[DATE_COL] && r[DATE_COL] !== 'TBA') !== !!r[TIME_COL]);
  if (halfFilled.length) {
    console.warn(`  ⚠ ${halfFilled.length} row(s) have a date without a time (or vice versa): ${list(halfFilled.map((r) => r['COURSE NO']))}`);
  }

  console.log(`Wrote ${outputPath}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
