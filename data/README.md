# Database Synchronization

This folder is the **source of truth** for the timetable data. It's used to automatically sync CSV
data to the Supabase database.

Whenever you update or add `timetable.csv`, `midsem.csv`, or `compre.csv` (or change
`semester.txt`) and push to the `main` branch, the GitHub Action
(`.github/workflows/sync-supabase.yml`) automatically clears the old data and inserts your new
data into Supabase.

> **How the app reads this:** the web app never queries Supabase directly. It fetches the data
> through a cached same-origin Edge API — `/api/timetable` (served from Supabase with the
> service-role key server-side, cached in Upstash Redis) — and checks `/api/pointer` for the
> current `{ semester, version }` to know when to refresh its local cache.

## 🗓️ Semester & versioning (`semester.txt`)

`data/semester.txt` holds the current semester label (e.g. `2025-S2`). On each sync, the pipeline
records the semester and a **version** number in a small `metadata` table:

- Same semester → version is **incremented** (`+1`), signalling clients to refresh.
- New semester (the label changed) → version **resets to 1**.

Change `semester.txt` when rolling over to a new semester. You can also trigger the sync manually
via **workflow_dispatch**, optionally passing the semester as an input (blank falls back to
`semester.txt`).

## 📄 Generating `timetable.csv` from the PDF

The official timetable comes as a PDF. You don't have to convert it by hand:

- **No clone needed:** upload the PDF into this `data/` folder on GitHub (**Add file → Upload
  files** → commit to a new branch). The **Convert timetable PDF** action turns it into
  `data/timetable.csv` on that branch automatically. The semester (`semester.txt`) is set from the
  **Actions**-tab input, the **PDF filename** (e.g. `timetable-2025-S2.pdf`), or — failing those —
  the semester printed on the **PDF's title page**; it's kept unchanged if none apply.
- **Locally:** clone the repo, then:
  ```bash
  npm install                              # first time only
  npm run pdf -- path/to/timetable.pdf     # writes data/timetable.csv
  ```

The converter skips the instruction/legend pages, removes the repeated page headers, keeps only
the schema columns (renamed to match), and rejoins wrapped cells. It's best-effort — always
review the output against the PDF. See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the full
workflow.

## 🗓️ Generating `midsem.csv` / `compre.csv` from the exam PDF

The exam schedules are published as their own PDFs, separately from the timetable, and the final
dates often differ from the tentative ones already in `timetable.csv` — which is exactly what these
override files are for. To convert one:

```bash
npm install                                        # first time only
npm run exam -- "path/to/Mid Sem 2026-27.pdf"      # writes data/midsem.csv
npm run exam -- "path/to/Compre 2026-27.pdf"       # writes data/compre.csv
```

Midsem vs compre is detected from the table header, then the PDF's title, then the filename; pass
`--kind=midsem` or `--kind=compre` to force it. A second positional argument overrides the output
path.

**No clone needed:** upload the PDF into this `data/` folder on GitHub (**Add file → Upload files**
→ commit to a new branch) and the **Convert exam PDF (midsem / compre)** action converts it on that
branch automatically, then you open a PR → main.

> ⚠️ **Name the file so it contains `midsem` (or `mid sem`) or `compre`** — e.g.
> `Mid Sem 2026-27.pdf`, `Compre 2026-27.pdf`. The exam and timetable converters watch the same
> folder and split the work by filename: anything *not* matching those words is treated as a
> **timetable** and would overwrite `timetable.csv`.

The converter reconciles the source's inconsistencies with the conventions used in
`timetable.csv`:

| In the PDF | In the CSV |
| :--- | :--- |
| `10/10/2026,Saturday` / `03/10/2026, Saturday` | `10/10/2026, Sat` — always `DD/MM/YYYY, Ddd` |
| a date with no weekday, or a 2-digit year | weekday derived from the date; year expanded |
| `NO MID SEM` / `NO COMPRE` | empty date (the literal never appears in `timetable.csv`) |
| `TBA` | `TBA` (kept — it's a real value) |
| `BETWEEN 04:00 PM - 07:00 PM` | `04:00 PM - 07:00 PM` |
| `14/12/2026 (FN)` | date `14/12/2026, Mon` + time `(FN)` |
| a course number wrapped over two lines | rejoined (`BITS F463/ BITS U463`) |
| columns we don't store (instructor, com code, remarks) | dropped |

Header wording is matched loosely, so `MIDSEM DATE`, `MIDSEM DATE,DAY` and
`MID SEM DATE & DAY` are all understood, and any unrecognised column is ignored rather than
treated as an error.

It prints a report of everything it normalised, plus warnings for anything it could not parse, a
weekday that disagrees with its date, duplicate course numbers, and notes it had to drop from a
date cell (e.g. *"No mid sem for RMIT students"* — there's no column for those). **Read that report
and review the diff before committing** — it's best-effort, and the source PDFs contain occasional
typos.

## 📝 Instructions for Committing

1. **Format:** Ensure your files are named exactly `timetable.csv`, `midsem.csv`, or `compre.csv`.
   (`midsem.csv` and `compre.csv` are optional override files.)
2. **Headers:** The first row of your CSV **must** contain the exact column names specified in the schemas below.
3. **Data Types:** Supabase will automatically generate the `id` UUID for every new row. You do **not** need an `id` column in your CSV.
4. **Action:** Overwriting an existing file in this folder and pushing it to `main` will completely replace the respective table in the database with the new data.

---

## 📊 Schemas

### 1. `timetable.csv`
This file updates the `Timetable` table in Supabase. The CSV must have the following exact headers (case-sensitive and space-sensitive):

| Column Header | Description | Example |
| :--- | :--- | :--- |
| `COURSE NO` | The unique course identifier. | `CS F111` |
| `COURSE TITLE` | The name of the course. | `COMPUTER PROGRAMMING` |
| `L P U` | Lecture, Practical, Units distribution. | `3 0 3` |
| `STAT` | The type of class (L = Lecture, T = Tutorial, P = Practical). | `L` |
| `SEC` | The section number. | `1` |
| `INSTRUCTOR IN CHARGE/Instructor` | The name of the instructor. | `John Doe` |
| `DAYS/HR` | The timeslot schedule. | `M W F 1 2` |
| `ROOM` | The classroom location. | `A124` |
| `COMPRE DATE` | Date of the comprehensive exam. | `12/05/2024` |
| `MIDSEM DATE,DAY` | Midsem date and day. | `15/03/2024` |
| `MIDSEM TIME` | Time of the midsem. | `10:00 - 11:30` |

### 2. `midsem.csv`
This file updates the `Midsem` table in Supabase, which provides overrides for the mid-semester examination schedules.

| Column Header | Description | Example |
| :--- | :--- | :--- |
| `COURSE NO` | The unique course identifier. | `CS F111` |
| `COURSE TITLE` | The name of the course. | `COMPUTER PROGRAMMING` |
| `MIDSEM DATE,DAY` | Date and day of the midsem exam. | `15/03/2024` |
| `MIDSEM TIME` | Time slot for the midsem exam. | `10:00 - 11:30` |

> ⚠️ **Note on Multiple Courses:** If a single midsem exam applies to multiple cross-listed courses (e.g., `ECOM F342/ CS F342`), the system will automatically parse them as long as they are separated by a `/`.

### 3. `compre.csv`
This file updates the `Compre` table in Supabase, which provides overrides for the comprehensive examination schedules. It shares a similar schema structure to Midsem.

| Column Header | Description | Example |
| :--- | :--- | :--- |
| `COURSE NO` | The unique course identifier. | `CS F111` |
| `COURSE TITLE` | The name of the course. | `COMPUTER PROGRAMMING` |
| `COMPRE DATE,DAY` | Date and day of the compre exam. | `12/05/2024` |
| `COMPRE TIME` | Time slot for the compre exam. | `10:00 - 13:00` |
