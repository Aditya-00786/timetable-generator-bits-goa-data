# 📅 BITS Goa Timetable Generator — Data & Contributions

> The public **timetable data** and **contribution hub** for the BITS Goa Timetable Generator.

[![Live App](https://img.shields.io/badge/Live-App-black.svg)](https://timetable-generator-bits-goa.vercel.app/)
[![Validate data](https://github.com/Aditya-00786/timetable-generator-bits-goa-data/actions/workflows/validate-data.yml/badge.svg)](https://github.com/Aditya-00786/timetable-generator-bits-goa-data/actions/workflows/validate-data.yml)

**🔗 Use the app: https://timetable-generator-bits-goa.vercel.app/**

This repository holds the **source timetable data** that powers the app, plus everything you need
to **contribute updates**. When timetable data changes here, it syncs automatically to the live
app. The application's front-end source code is maintained separately.

---

## ✨ What the app does

- **Build your timetable fast** — enter your BITS ID to auto-load your compulsory courses, then
  pick Lecture (L), Tutorial (T), and Practical (P) sections with live clash detection.
- **Auto-select** — one tap picks an optimal, conflict-free set of sections for all your courses,
  with an optional **Minimize Gaps** preference and a max-hours cap.
- **Swap electives** — browse and swap Humanities Electives (HELs) without breaking your schedule.
- **Exam schedules** — dedicated Midsem and Compre views.
- **Share your timetable** — send a link; friends open your exact schedule instantly.
- **Find free slots with friends** — create a Group, have friends join, and see a shared
  availability heatmap of everyone's common free time.
- **Export to your calendar** — 1-click Google Calendar sync or an iCal (.ics) download.
- **Install it as an app** — works offline, updates seamlessly, remembers your session. Automatic
  light/dark mode and fully responsive on mobile.

---

## 🤝 Contributing timetable data

Spotted an error, or have updated data for a new semester? Contributions are welcome!

1. **Fork** this repo.
2. **Clone the repo** and enter the folder:
   ```bash
   git clone https://github.com/Aditya-00786/timetable-generator-bits-goa-data.git
   cd timetable-generator-bits-goa-data
   ```
3. **Edit the CSVs** in [`data/`](./data/) following the schema in [`data/README.md`](./data/README.md):
   - `data/timetable.csv` — the main timetable (required)
   - `data/midsem.csv`, `data/compre.csv` — optional exam-date overrides
   - `data/semester.txt` — the semester label (update it when a new semester starts)
4. **Validate locally** (optional but recommended):
   ```bash
   npm install
   npm run validate
   ```
5. **Open a pull request.** A **"Validate data"** check runs automatically and flags any
   formatting issues.
6. A maintainer reviews and merges. On merge to `main`, the data **syncs to the live app
   automatically**.

> **Updating the whole timetable for a new semester?** You don't even need to clone — just
> **upload the official PDF** into `data/` on a new branch, and the **Convert timetable PDF**
> action turns it into `timetable.csv` for you.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

---

## 🔄 How the data flows

```
data/*.csv  ──(PR + review)──▶  main  ──(GitHub Action)──▶  Supabase  ──▶  Live app
```

Merging data changes to `main` triggers a GitHub Action that replaces the data in the app's
database and bumps a version number, so the app knows to refresh. See
[`data/README.md`](./data/README.md) for the schemas and semester/versioning details.

---

## 📝 License

Licensed under the MIT License — see [LICENSE](./LICENSE).

## 🌟 Acknowledgments
- Built by BITSians, for BITSians.
- Uses BITS Pilani academic structure and course codes.
