# Concurrency test rig

Runs the real `index.html` against a local copy of the Apps Script backend, so two
people editing at once can be tested **without touching the live Sheet**.

```bash
python3 test/mock.py 8799          # first run reads the live Sheet once into test/seed.json
```

Open `http://localhost:8799/` in two tabs, then in each tab's console:

```js
eval(await (await fetch('/harness.js')).text())   // admin mode + notice recorder
__t.rotEnd('Kevin Allen', '2026-10-09')           // edits go through the UI's own handlers
await __t.commit()
__t.notices()                                     // every notice the user saw, in order
```

Knobs: `/_admin/reset` · `/_admin/bump` (automation-style rev bump) · `/_admin/delay?ms=1200`
(real backend latency) · `/_admin/state` (server data + commit log: OK / STALE).

**The bar a change must clear:** one edit + Commit shows exactly `Saving… → ✅ Saved`, even
when the Sheet moved underneath. A dialog appears only when two people changed the same thing.
`ntfy` is stubbed by the harness — tests never ping a phone.
