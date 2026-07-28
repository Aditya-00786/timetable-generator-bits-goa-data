# test/ — scratch area for the Adobe conversion workflow

Drop a timetable PDF here (e.g. `test/timetable.pdf`) and run the **Convert timetable PDF (Adobe)**
workflow (Actions → Run workflow) pointing `pdf_path` at it. The workflow converts it and uploads
`timetable.csv` + the intermediate `.xlsx` as build artifacts — it does **not** touch `data/`, so the
existing `pdf-to-csv` / sync pipeline is unaffected. This directory is just for trying the new flow.
