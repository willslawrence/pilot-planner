# Pilot Planner — Apps Script backend

The Google Apps Script web app that serves the planner's data. It is **container-bound** to the Pilot Planner Google Sheet (`1w6JkP-Leh1qrIEwkVEkgH5oTUZfDNPwX3zCggH5G-Kc`), not a standalone project — so it doesn't show up in `clasp list-scripts`. Cloned here via its Script ID so the backend is versioned alongside the frontend (`../index.html`).

## Files
- `Code.js` — the web app (`doGet`/`doPost`).
- `appsscript.json` — manifest.
- `.clasp.json` — clasp link (Script ID + `rootDir`).

## Endpoints
- `GET ?action=readAll` — returns `{pilots, rotations, missions, assignments}`. `sheetToJson` maps **sheet headers → JSON keys dynamically**, so adding a column to a tab surfaces it in the API with no code change.
- `POST ?action=write&sheet=<tab>` — **positional** full-replace of rows 2+ (row 1 headers preserved). Frontend row order must match the sheet header order.
- `POST ?action=upsert` — header-mapped upsert by `MissionID` (used by `sync_obsidian_missions.py`).
- `POST ?action=append&sheet=<tab>`.

## Workflow
```bash
cd apps-script
clasp pull      # fetch the live script into this folder
clasp push      # deploy local changes to the bound script
```
The deployed web-app URL (`AKfycb…/exec`) is hardcoded as `BASE_URL` in `../index.html`. After `clasp push`, redeploy the web app if you changed `doGet`/`doPost` signatures.

> Owner account: `cptwilllawrence@gmail.com`. If `clasp push` 403s, `clasp login` as that account.
