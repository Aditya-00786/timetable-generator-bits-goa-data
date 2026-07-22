# Contributing

Thanks for helping keep the BITS Goa Timetable Generator accurate! This repo accepts
**timetable data** contributions. (The application's source code is maintained separately, so
code changes aren't handled here.)

## What you can contribute

- Corrections to course timings, instructors, rooms, sections, or exam dates in
  `data/timetable.csv`.
- Exam-date overrides in `data/midsem.csv` / `data/compre.csv` (both optional).
- The semester label in `data/semester.txt` when a new semester begins.

## How to submit a change

1. **Fork** this repository and create a branch.
2. **Edit the CSV(s)** in [`data/`](./data/). The headers must match the schema **exactly**
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
