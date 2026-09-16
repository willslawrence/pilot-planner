"""Local stand-in for the planner's Apps Script backend.

Mirrors Code.js exactly where it matters for concurrency:
  readAll            -> every tab + rev + changelog
  commitAll          -> rev guard, clear-then-write per non-empty tab,
                        mergePilotRows_, changelog append, rev + 1
Plus test-only knobs no real client ever calls:
  /_admin/bump       -> automation-style rev bump (int(time.time()), no data change)
  /_admin/reset      -> reseed from seed.json
  /_admin/state      -> dump
  /_admin/delay?ms=N -> add latency, so races behave like the real 1-3 s backend
"""
import json, os, sys, time, threading, copy
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(__file__)
SEED_PATH = os.path.join(HERE, 'seed.json')          # gitignored: it is live roster data
LIVE = "https://script.google.com/macros/s/AKfycbx2PG54ptMJw3eJW2vxNrvRJOaJVfXzOQYnJg-qHbV0vrBU1W16tq2lpGKlVfVXVpyX6w/exec?action=readAll"
if not os.path.exists(SEED_PATH):                    # one READ of the live Sheet; nothing is ever written back
    import urllib.request
    print('reading live Sheet once for test/seed.json …', flush=True)
    data = urllib.request.urlopen(LIVE, timeout=60).read()
    json.loads(data)                                  # refuse to save a half or HTML response
    open(SEED_PATH + '.tmp', 'wb').write(data)
    os.replace(SEED_PATH + '.tmp', SEED_PATH)         # atomic: an interrupted run leaves no seed
SEED = json.load(open(SEED_PATH))
PAGE_SRC = os.path.join(HERE, '..', 'index.html')
HEADERS = {
  'Pilots':      ['Name','Category','FleetplanID','PairGroup','Management','DisplayName','Temp','Part121','BaseMonth'],
  'Rotations':   ['Pilot','Type','Start','End','FleetplanID','LastSynced','Note'],
  'Missions':    ['MissionID','Name','Type','Start','End','Helicopters','Color','Status','ObsidianFile','LastSynced','HelicopterDetails','OperatingDays'],
  'Assignments': ['Pilot','MissionID','HeliSlot','Start','End','LastSynced','Note'],
}
LOCK = threading.Lock()
S = {}
DELAY = {'ms': 0}
LOG = []

def reset():
    S.clear()
    for t in HEADERS:
        S[t] = [[r.get(h, '') for h in HEADERS[t]] for r in SEED[t.lower()]]
    S['rev'] = SEED['rev']
    S['changelog'] = list(SEED['changelog'])
    LOG.clear()
reset()

def coerce(v):
    """What Google Sheets does to a value written via setValues."""
    if isinstance(v, str):
        if v == 'TRUE': return True
        if v == 'FALSE': return False
        if v.isdigit() and len(v) < 12: return int(v)
    return v

def is_blank(v):
    return v == '' or v is None or v is False or str(v).upper() == 'FALSE'

def merge_pilot_rows(existing, incoming):
    key = lambda v: str(v or '').strip().lower()
    width = max(len(HEADERS['Pilots']), len(incoming[0]))
    by = {key(r[0]): r for r in existing if key(r[0])}
    seen, out = set(), []
    for row in incoming:
        seen.add(key(row[0])); old = by.get(key(row[0]), [])
        out.append([ (old[i] if i < len(old) else '') if is_blank(row[i] if i < len(row) else '') and not is_blank(old[i] if i < len(old) else '')
                     else (row[i] if i < len(row) else '') for i in range(width)])
    for r in existing:
        if key(r[0]) and key(r[0]) not in seen:
            out.append((r + [''] * width)[:width])
    return out

def read_all():
    res = {t.lower(): [dict(zip(HEADERS[t], (r + [''] * len(HEADERS[t]))[:len(HEADERS[t])])) for r in S[t]] for t in HEADERS}
    res['rev'] = S['rev']; res['changelog'] = S['changelog']
    return res

def commit_all(body):
    with LOCK:
        cur = S['rev']
        if body.get('rev') is None or int(body['rev']) != cur:
            LOG.append({'t': time.time(), 'commit': 'STALE', 'sent': body.get('rev'), 'cur': cur})
            return {'success': False, 'stale': True, 'currentRev': cur}
        total = 0
        for t, k in (('Assignments','assignments'),('Missions','missions'),('Rotations','rotations'),('Pilots','pilots')):
            rows = body.get(k) or []
            if not rows: continue
            rows = [[coerce(v) for v in r] for r in rows]
            if t == 'Pilots': rows = merge_pilot_rows(S[t], rows)
            S[t] = rows; total += len(rows)
        for e in body.get('changelog') or []:
            S['changelog'].append({'ts': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()), **{k: e.get(k,'') for k in ('pilot','kind','period','summary')}})
        S['rev'] = cur + 1
        LOG.append({'t': time.time(), 'commit': 'OK', 'rev': S['rev'], 'rows': total})
        return {'success': True, 'rowsWritten': total, 'rev': S['rev'], 'logged': len(body.get('changelog') or [])}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj, ctype='application/json'):
        b = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def _lag(self):
        if DELAY['ms']: time.sleep(DELAY['ms'] / 1000)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path in ('/', '/index.html'):
            html = open(PAGE_SRC, encoding='utf-8').read()
            import re
            html = re.sub(r'const BASE_URL = "[^"]+";', 'const BASE_URL = "/api";', html, count=1)
            return self._send(200, html.encode(), 'text/html; charset=utf-8')
        if u.path == '/harness.js':
            return self._send(200, open(os.path.join(HERE,'harness.js'),'rb').read(), 'text/javascript')
        if u.path == '/api':
            self._lag()
            return self._send(200, read_all())
        if u.path == '/_admin/bump':
            with LOCK: S['rev'] = max(S['rev'] + 1, int(time.time()))
            LOG.append({'t': time.time(), 'bump': S['rev']}); return self._send(200, {'rev': S['rev']})
        if u.path == '/_admin/reset':
            with LOCK: reset()
            return self._send(200, {'ok': True, 'rev': S['rev']})
        if u.path == '/_admin/delay':
            DELAY['ms'] = int(q.get('ms', ['0'])[0]); return self._send(200, DELAY)
        if u.path == '/_admin/state':
            return self._send(200, {**read_all(), 'log': LOG})
        return self._send(404, {'error': 'nope'})
    def do_POST(self):
        u = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if u.path == '/api':
            self._lag()
            return self._send(200, commit_all(body))
        return self._send(404, {'error': 'nope'})

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    print('mock on', port, flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
