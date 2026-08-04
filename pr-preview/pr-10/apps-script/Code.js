const SHEET_NAME = 'Pilot Planner Data';

// --- Stale-page guard: Sheet revision counter (PlannerMeta!A1) ---
// Every write bumps it; readAll returns it; commitAll rejects a commit whose
// rev doesn't match (the page loaded before someone else's commit), so a stale
// page can never overwrite newer data.
const META_TAB = 'PlannerMeta';

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
 const rev = bumpRev_();
 return {success: true, rowsWritten: total, rev: rev};
 } finally {
 lock.releaseLock();
 }
}

function jsonResponse(data) {
 return ContentService
 .createTextOutput(JSON.stringify(data))
 .setMimeType(ContentService.MimeType.JSON);
}