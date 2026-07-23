# Contributing

Thanks for helping keep the BITS Goa Timetable Generator accurate! This repo accepts
**timetable data** contributions. (The application's source code is maintained separately, so
code changes aren't handled here.)

## What you can contribute

- Corrections to course timings, instructors, rooms, sections, or exam dates in
  `data/timetable.csv`.
- Exam-date overrides in `data/midsem.csv` / `data/compre.csv` (both optional).
- The semester label in `data/semester.txt` when a new semester begins.

## Getting set up

Clone the repo and install dependencies (fork first if you don't have write access):

```bash
git clone https://github.com/Aditya-00786/timetable-generator-bits-goa-data.git
cd timetable-generator-bits-goa-data
npm install
```

## Updating the whole timetable (new semester)

Each semester the timetable is released as a PDF. You don't have to convert it by hand — there
are two ways to turn it into `data/timetable.csv`:

### Option A — upload the PDF on GitHub (no clone needed) ✨

1. On GitHub, click **Add file → Upload files**.
2. Drag the timetable PDF into the **`data/`** folder.
3. Choose **"Commit to a new branch"** (e.g. `update-timetable`) and commit.
4. Wait ~1 min for the **Convert timetable PDF** action to finish. It converts the PDF to
   `data/timetable.csv`, validates it, and commits the result back to your branch (removing the
   uploaded PDF).
5. Open a **pull request** from that branch to `main` — then jump to step 4 of
   [How to submit a change](#how-to-submit-a-change).

### Option B — convert locally

Clone the repo, install dependencies, and run the converter:

```bash
git clone https://github.com/Aditya-00786/timetable-generator-bits-goa-data.git
cd timetable-generator-bits-goa-data
npm install                              # first time only
npm run pdf -- path/to/timetable.pdf     # writes data/timetable.csv
```

Either way, the converter skips the title/instruction/legend pages, drops the header row repeated
on every page, keeps only the schema columns (renaming them to match), and stitches wrapped cells
(long titles, instructor lists, dates spanning two lines) back together.

It's a **best-effort** parser for the digital-text PDF, so **always review the result** before
merging — check a few rows against the PDF, especially wrapped day/time cells. For a new semester,
remember to bump `data/semester.txt` too.

## How to submit a change

1. Create a branch on your fork (see [Getting set up](#getting-set-up) above).
2. **Edit the CSV(s)** in [`data/`](./data/) — or generate `timetable.csv` with the converter
   above. The headers must match the schema **exactly**
   (case- and space-sensitive) — see [`data/README.md`](./data/README.md) for every column.
   - Do **not** add an `id` column; the database generates it.
   - `data/timetable.csv` is required and must not be empty.
   - For a new semester, update `data/semester.txt` (e.g. `2025-S2`) — this resets the data
     version.
3. **Validate your changes locally** (recommended):
   ```bash
   npm install
   npm run validate
   ```
   This checks that the files parse and have the right headers — the exact same check that runs
   on your PR.
4. **Open a pull request.** The **"Validate data"** GitHub Action runs automatically and reports
   any issues. No secrets are involved, so it runs safely on forks.
5. A maintainer reviews and merges. **On merge to `main`, the data syncs to the live app
   automatically** and the version bumps so users pick up the change.

## Tips

- Keep edits focused — one logical change per PR is easiest to review.
- If a single exam applies to cross-listed courses (e.g. `ECOM F342/ CS F342`), separate them
  with a `/` and the system will parse them.
- When in doubt about a column's format, copy the style of existing rows.

Thanks again — every correction helps every BITSian who uses the app. 🙌
