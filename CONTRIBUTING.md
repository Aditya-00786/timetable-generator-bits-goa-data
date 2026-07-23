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

Fork this repo, then clone your fork and install dependencies:

```bash
git clone https://github.com/<your-username>/timetable-generator-bits-goa-data.git
cd timetable-generator-bits-goa-data
npm install
```

## Generating `timetable.csv` from the official PDF

Each semester the timetable is released as a PDF. Instead of exporting to Excel and cleaning it
up by hand, use the converter:

```bash
npm run pdf -- path/to/timetable.pdf     # writes data/timetable.csv
```

It automatically skips the title/instruction/legend pages, drops the header row repeated on
every page, keeps only the schema columns (renaming them to match), and stitches wrapped cells
(long titles, instructor lists, dates spanning two lines) back together.

It's a **best-effort** parser for the digital-text PDF, so **always eyeball the result** before
committing — check a few rows against the PDF, especially wrapped day/time cells. Then follow the
steps below to validate and open a PR. (After generating, you'll usually just bump
`data/semester.txt` too.)

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
