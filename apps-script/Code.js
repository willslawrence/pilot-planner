const SHEET_NAME = 'Pilot Planner Data';

// --- Stale-page guard: Sheet revision counter (PlannerMeta!A1) ---
// Every write bumps it; readAll returns it; commitAll rejects a commit whose
// rev doesn't match (the page loaded before someone else's commit), so a stale
// page can never overwrite newer data.
const META_TAB = 'PlannerMeta';

// --- Change log: append-only feed of material roster changes ---
// The planner diffs its loaded baseline against what it is about to commit and
// sends the human-readable result here. This tab is APPENDED to, never cleared —
// deliberately unlike the four data tabs, whose clear-then-write is what
// destroyed Lisa le Roux's and Dermot Fahy's rosters (2026-08-23/24).
const CHANGELOG_TAB = 'ChangeLog';
const CHANGELOG_HEADERS = ['Timestamp', 'Pilot', 'Kind', 'Period', 'Summary'];
const CHANGELOG_RETAIN_DAYS = 90;

function getChangeLogSheet_() {
 const ss = SpreadsheetApp.getActiveSpreadsheet();
 let sh = ss.getSheetByName(CHANGELOG_TAB);
 if (!sh) {
 sh = ss.insertSheet(CHANGELOG_TAB);
 sh.getRange(1, 1, 1, CHANGELOG_HEADERS.length).setValues([CHANGELOG_HEADERS]);
 sh.setFrozenRows(1);
 // Plain text on every column. Sheets otherwise parses a Period like "Nov 2026"
 // into a real date and readAll hands the panel "2026-11-01T00:00:00.000Z".
 sh.getRange(1, 1, sh.getMaxRows(), CHANGELOG_HEADERS.length).setNumberFormat('@');
 }
 return sh;
}

// Appends entries and drops anything past the retention window, so the tab can
// never grow without bound. Returns the number of rows appended.
function appendChangeLog_(entries) {
 if (!entries || !entries.length) return 0;
 const sh = getChangeLogSheet_();
 const rows = entries.map(function(e) {
 return [e.ts || new Date().toISOString(), e.pilot || '', e.kind || '', e.period || '', e.summary || ''];
 });
 const target = sh.getRange(sh.getLastRow() + 1, 1, rows.length, CHANGELOG_HEADERS.length);
 target.setNumberFormat('@'); // belt and braces for tabs created before the format was set
 target.setValues(rows);
 pruneChangeLog_(sh);
 return rows.length;
}

function pruneChangeLog_(sh) {
 const last = sh.getLastRow();
 if (last < 2) return;
 const cutoff = new Date(Date.now() - CHANGELOG_RETAIN_DAYS * 86400000).toISOString();
 const stamps = sh.getRange(2, 1, last - 1, 1).getValues();
 // Rows are appended in time order, so everything stale is a leading run.
 let stale = 0;
 while (stale < stamps.length && String(stamps[stale][0]) < cutoff) stale++;
 if (stale > 0) sh.deleteRows(2, stale);
}

function readChangeLog_() {
 const sh = getChangeLogSheet_();
 const last = sh.getLastRow();
 if (last < 2) return [];
 return sh.getRange(2, 1, last - 1, CHANGELOG_HEADERS.length).getValues().map(function(r) {
 return {ts: String(r[0]), pilot: r[1], kind: r[2], period: r[3], summary: r[4]};
 }).filter(function(e) { return e.ts && e.summary; }); // tolerate blank rows left in the tab
}

function getRev_() {
 const ss = SpreadsheetApp.getActiveSpreadsheet();
 let sh = ss.getSheetByName(META_TAB);
 if (!sh) {
 sh = ss.insertSheet(META_TAB);
 sh.getRange('A1').setValue(0);
 sh.getRange('B1').setValue('Planner revision counter — do not edit. Bumped on every write; rejects stale-page commits.');
 sh.hideSheet();
 }
 const v = Number(sh.getRange('A1').getValue());
 return isNaN(v) ? 0 : v;
}

function bumpRev_() {
 const n = getRev_() + 1; // getRev_ ensures the tab exists
 SpreadsheetApp.getActiveSpreadsheet().getSheetByName(META_TAB).getRange('A1').setValue(n);
 return n;
}

function doGet(e) {
 const action = (e.parameter.action || 'readAll').toLowerCase();
 const ss = SpreadsheetApp.getActiveSpreadsheet();

 if (action === 'read') {
 const sheetName = e.parameter.sheet;
 if (!sheetName) return jsonResponse({error: 'Missing sheet parameter'});
 const sheet = ss.getSheetByName(sheetName);
 if (!sheet) return jsonResponse({error: 'Sheet not found: ' + sheetName});
 return jsonResponse({data: sheetToJson(sheet)});
 }

 if (action === 'readall') {
 const tabs = ['Pilots', 'Rotations', 'Missions', 'Assignments'];
 const result = {};
 tabs.forEach(name => {
 const sheet = ss.getSheetByName(name);
 result[name.toLowerCase()] = sheet ? sheetToJson(sheet) : [];
 });
 result.rev = getRev_(); // stale-page guard: page remembers this, sends it back on commitAll
 result.changelog = readChangeLog_(); // recent material changes, for the Changes panel
 return jsonResponse(result);
 }
 return jsonResponse({error: 'Unknown action: ' + action});
}

function doPost(e) {
 const params = e.parameter;
 const action = (params.action || '').toLowerCase();
 const ss = SpreadsheetApp.getActiveSpreadsheet();

 // --- upsert (for sync_obsidian_missions.py) ---
 if (action === 'upsert') {
   var payload;
   try {
     payload = JSON.parse(e.postData.contents);
   } catch (err) {
     return jsonResponse({error: 'Invalid JSON: ' + err.message});
   }

   var ops = payload.operations || [payload];
   var results = [];

   for (var i = 0; i < ops.length; i++) {
     var op = ops[i];
     var mission = op.mission || op;
     var sheet = ss.getSheetByName('Missions');
     var headers = sheet.getDataRange().getValues()[0];
     var missionId = mission.MissionID;

     var lastRow = sheet.getLastRow();
     var ids = sheet.getRange(1, 1, lastRow, 1).getValues();
     var rowIdx = -1;
     for (var r = 0; r < lastRow; r++) {
       if (ids[r][0] == missionId) { rowIdx = r + 1; break; }
     }

     var row = headers.map(function(h) {
       var key = String(h).replace(/\s+/g, '');
       return mission[key] !== undefined ? mission[key] : '';
     });

     if (rowIdx > 0) {
       sheet.getRange(rowIdx, 1, 1, row.length).setValues([row]);
       results.push({action: 'updated', missionId: missionId, row: rowIdx});
     } else {
       sheet.appendRow(row);
       results.push({action: 'appended', missionId: missionId});
     }
   }
   bumpRev_(); // mission sync writes count as changes for the stale-page guard
   return jsonResponse({results: results});
 }

 // --- commitAll (atomic multi-tab write with stale-page guard) ---
 if (action === 'commitall') {
   var caBody;
   try {
     caBody = JSON.parse(e.postData.contents);
   } catch (err) {
     return jsonResponse({error: 'Invalid JSON: ' + err.message});
   }
   return jsonResponse(handleCommitAll(ss, caBody));
 }

 // --- write (full replace) ---
 if (action === 'write') {
 const sheetName = params.sheet;
 if (!sheetName) return jsonResponse({error: 'Missing sheet parameter'});
 const sheet = ss.getSheetByName(sheetName);
 if (!sheet) return jsonResponse({error: 'Sheet not found: ' + sheetName});

 const body = JSON.parse(e.postData.contents);
 const rows = body.rows;
 if (!rows || !rows.length) return jsonResponse({error: 'No rows provided'});
 const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
 sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), sheet.getLastColumn()).clearContent();
 if (rows.length > 0) {
 sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
 }

 bumpRev_(); // legacy writers (old cached pages, scripts) still count as changes
 return jsonResponse({success: true, rowsWritten: rows.length, sheet: sheetName});
 }

 // --- append ---
 if (action === 'append') {
 const sheetName = params.sheet;
 if (!sheetName) return jsonResponse({error: 'Missing sheet parameter'});
 const sheet = ss.getSheetByName(sheetName);
 if (!sheet) return jsonResponse({error: 'Sheet not found: ' + sheetName});

 const body = JSON.parse(e.postData.contents);
 const rows = body.rows;
 if (!rows || !rows.length) return jsonResponse({error: 'No rows provided'});

 sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
 bumpRev_();
 return jsonResponse({success: true, rowsAppended: rows.length, sheet: sheetName});
 }

 return jsonResponse({error: 'Unknown action: ' + action});
}

function sheetToJson(sheet) {
 const data = sheet.getDataRange().getValues();
 if (data.length < 2) return [];
 const headers = data[0];
 return data.slice(1).map(row => {
 const obj = {};
 headers.forEach((h, i) => { obj[h] = row[i]; });
 return obj;
 });
}

// Atomic multi-tab replace, serialized by LockService, guarded by the rev counter.
// Skips any tab whose rows array is empty (never clears a tab to nothing).
function handleCommitAll(ss, body) {
 const lock = LockService.getScriptLock();
 lock.waitLock(20000);
 try {
 const current = getRev_();
 if (body.rev === null || body.rev === undefined || Number(body.rev) !== current) {
 return {success: false, stale: true, currentRev: current};
 }
 const writes = {
 'Assignments': body.assignments,
 'Missions': body.missions,
 'Rotations': body.rotations,
 'Pilots': body.pilots
 };
 let total = 0;
 for (const tab in writes) {
 const rows = writes[tab];
 if (!rows || !rows.length) continue;
 const sheet = ss.getSheetByName(tab);
 if (!sheet) continue;
 const last = sheet.getLastRow();
 if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getMaxColumns()).clearContent();
 sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
 total += rows.length;
 }
 // Append AFTER the data writes, still inside the lock: a change log entry must
 // never describe a commit that did not land.
 let logged = 0;
 try {
 logged = appendChangeLog_(body.changelog);
 } catch (err) {
 // A change log failure must never fail the commit — the roster is the payload.
 logged = 0;
 }
 const rev = bumpRev_();
 return {success: true, rowsWritten: total, rev: rev, logged: logged};
 } finally {
 lock.releaseLock();
 }
}

function jsonResponse(data) {
 return ContentService
 .createTextOutput(JSON.stringify(data))
 .setMimeType(ContentService.MimeType.JSON);
}