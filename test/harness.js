(() => {
  if (window.__t) return 'harness already on';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now(), rec = [];
  const add = (kind, text) => rec.push({ ms: Math.round(performance.now() - t0), kind, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 120) });
  const wrap = (name, kind, pick) => { const f = window[name];
    window[name] = function (...a) { add(kind, pick ? pick(a) : a[0]); return f.apply(this, a); }; };
  wrap('showMessage', 'toast');
  wrap('showSaving', 'spinner', () => 'Saving…');
  wrap('hideSaving', 'result', a => a[0] === true ? '✅ Saved' : a[0] === false ? '❌ Failed' : '(spinner closed)');
  wrap('showConflictModal', 'DIALOG', a => a[0].map(c => c.what + ' — ' + c.why).join(' | '));
  window.notifyNtfy = (t) => add('ntfy(stubbed)', t);          // never ping Will's phone from a test
  window.alert = m => add('alert', m);
  window.confirm = m => { add('confirm', m); return true; };
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType === 1 && n.parentNode === document.body && /position:\s*fixed;\s*top:\s*0/.test(n.getAttribute('style') || '')) add('BANNER', n.textContent);
  }))).observe(document.body, { childList: true });

  const idle = async () => { for (let i = 0; i < 80; i++) { await sleep(150);
    if (!_savingOverlay && !_mergeBusy && !document.getElementById('cfOk')) return; } throw new Error('never went idle'); };
  const T = {
    rec, sleep, idle,
    notices: () => rec.map(r => `${r.kind}: ${r.text}`),
    // --- edits, each through the same function the UI's own click handler calls ---
    rotEnd(name, newEnd) {                                   // click a rotation bar -> type end date -> Save
      const p = PILOTS.find(x => x.name === name); const ri = p.rot.findIndex(r => r.st === 'ON' || r.st === 'OFF');
      showRotPop({ clientX: 500, clientY: 300, target: document.body, stopPropagation(){}, preventDefault(){} }, p, ri);
      document.getElementById('rot-end').value = newEnd;
      document.querySelector('.psave').click();
      return p.rot[ri];
    },
    assign(mid, slot, pilot, s, e) {                         // pick a pilot from the slot picker (no updateDirtyState in that path)
      addAs(mid, slot, pilot, s, e); cPop(); render();
    },
    colour(mid, hex) {                                        // mission popup -> colour -> Save
      showPop({ clientX: 500, clientY: 200, target: document.body, stopPropagation(){}, preventDefault(){} }, mid);
      document.getElementById('pc').value = hex;
      document.querySelector('.psave').click();
    },
    async commit() { document.getElementById('commitBtn').click(); await sleep(300); await idle(); },
    focus() { _lastRevCheck = 0; window.dispatchEvent(new Event('focus')); },
    async pick(choices) {                                     // answer the conflict dialog
      for (let i = 0; i < 40 && !document.getElementById('cfOk'); i++) await sleep(150);
      if (!document.getElementById('cfOk')) return 'no dialog';
      if (choices === 'mine') document.getElementById('cfAllMine').click();
      if (choices === 'theirs') document.getElementById('cfAllTheirs').click();
      document.getElementById('cfOk').click();
      return 'answered ' + choices;
    },
    state: () => ({ rev: SHEET_REV, dirty: (updateDirtyState(), isDirty), stash: localStorage.getItem('pp_pendingOps') !== null }),
  };
  adminMode = true; applyModes(); render();
  window.__t = T;
  return { harness: 'on', rev: SHEET_REV, pilots: PILOTS.length };
})()
