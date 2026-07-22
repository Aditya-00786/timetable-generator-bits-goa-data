import fs from 'fs';
import Papa from 'papaparse';
import { createClient } from '@supabase/supabase-js';

// Provided by GitHub Actions secrets / env
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const semester = process.env.IMPORT_SEMESTER;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase env (VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}
if (!semester) {
  console.error('Missing IMPORT_SEMESTER (from the workflow input or data/semester.txt).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Columns that are numeric in the DB — coerced from CSV strings so the import RPC's
// jsonb_populate_recordset lands them in the right type.
const NUMERIC_COLUMNS = { Timetable: ['SEC'], Midsem: [], Compre: [] };

function parseCsv(filePath, numericColumns = []) {
  if (!fs.existsSync(filePath)) {
    console.log(`Skipping ${filePath} (not found) — its table will be left untouched.`);
    return null; // null → the RPC leaves that table as-is
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const { data, errors } = Papa.parse(content, { header: true, skipEmptyLines: true });
  if (errors.length) {
    console.error(`Errors parsing ${filePath}:`, errors);
    throw new Error(`Failed to parse ${filePath}`);
  }
  const rows = data.map((row) => {
    const out = { ...row };
    for (const col of numericColumns) {
      if (out[col] === '' || out[col] == null) out[col] = null;
      else {
        const n = Number(out[col]);
        out[col] = Number.isNaN(n) ? out[col] : n;
      }
    }
    return out;
  });
  console.log(`Parsed ${rows.length} rows from ${filePath}.`);
  return rows;
}

async function run() {
  console.log(`Starting timetable import for semester "${semester}"...`);

  const timetable = parseCsv('./data/timetable.csv', NUMERIC_COLUMNS.Timetable);
  const midsem = parseCsv('./data/midsem.csv', NUMERIC_COLUMNS.Midsem);
  const compre = parseCsv('./data/compre.csv', NUMERIC_COLUMNS.Compre);

  if (!timetable || timetable.length === 0) {
    console.error('data/timetable.csv is required and must not be empty (refusing to wipe the table).');
    process.exit(1);
  }

  // One atomic RPC: suppresses version triggers, replaces the tables, and sets
  // { current_semester, version } (reset to 1 on semester change, else +1).
  const { data, error } = await supabase.rpc('import_timetable', {
    p_semester: semester,
    p_timetable: timetable,
    p_midsem: midsem,
    p_compre: compre,
  });

  if (error) {
    console.error('Import failed:', error);
    process.exit(1);
  }

  console.log('Import complete:', data);

  // Best-effort cache warm: prime Redis (and the CDN at this POP) for the new version so
  // the first real user load isn't a cold Supabase rebuild. Non-fatal — the import already
  // succeeded; a failure here (e.g. endpoint not deployed yet) just means the first user
  // pays the rebuild once.
  const siteUrl = process.env.SITE_URL;
  if (siteUrl && data && data.semester && data.version != null) {
    const warmUrl = `${siteUrl.replace(/\/$/, '')}/api/timetable?semester=${encodeURIComponent(data.semester)}&v=${encodeURIComponent(String(data.version))}`;
    try {
      const res = await fetch(warmUrl);
      console.log(`Cache warm for v${data.version}: HTTP ${res.status}`);
    } catch (e) {
      console.log(`Cache warm skipped (${e?.message || e}).`);
    }
  }
}

run();
