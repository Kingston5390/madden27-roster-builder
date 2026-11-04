// Madden 27 Roster Builder: local server + UI. Runs as `node server.js` or packaged as RosterBuilder.exe.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { summarize, summarizeLegends, exportRoster } = require('./lib/roster');
const { leagueChaos } = require('./lib/league');
const { legendPhotos, prefetchAll, cachedPhotos } = require('./lib/photos');
const { fetchNfl, syncRoster, normName } = require('./lib/sync');

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(flag('--port') ?? 8790);
const OPEN = !args.includes('--no-open');
let savesDir = flag('--saves') ?? path.join(os.homedir(), 'Documents', 'Madden NFL 27', 'saves');

function loadUi() {
  try { const sea = require('node:sea'); if (sea.isSea()) return sea.getAsset('index.html', 'utf8'); } catch {}
  return fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
}

const cache = new Map();
function rosterInfo(file) {
  const full = path.join(savesDir, path.basename(file));
  const mtime = fs.statSync(full).mtimeMs;
  const hit = cache.get(full);
  if (hit && hit.mtime === mtime) return hit.json;
  const json = JSON.stringify(summarize(full));
  cache.set(full, { mtime, json });
  return json;
}

function listRosters() {
  if (!fs.existsSync(savesDir)) return [];
  return fs.readdirSync(savesDir).filter(f => /^ROSTER-/.test(f))
    .map(f => ({ name: f, modified: fs.statSync(path.join(savesDir, f)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
}

// Player headshots from ESPN's public NFL roster data, keyed by normalized name and cached on disk for a week
const HEADSHOT_CACHE = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder', 'headshots.json');
let headshots = null;
async function loadHeadshots() {
  if (headshots) return headshots;
  try {
    const c = JSON.parse(fs.readFileSync(HEADSHOT_CACHE, 'utf8'));
    if (Date.now() - c.fetched < 7 * 864e5) return (headshots = c);
  } catch {}
  const byName = {};
  for (const t of (await fetchNfl()).rosters) for (const a of t.players) if (a.headshot) byName[normName(a.name)] = a.headshot;
  headshots = { fetched: Date.now(), byName };
  fs.mkdirSync(path.dirname(HEADSHOT_CACHE), { recursive: true });
  fs.writeFileSync(HEADSHOT_CACHE, JSON.stringify(headshots));
  return headshots;
}

// Custom player photos uploaded in the app, keyed by normalized player name (shown in the app only; Madden faces are game assets)
const PHOTO_DIR = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder', 'custom-photos');
const PHOTO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function customPhotos() {
  if (!fs.existsSync(PHOTO_DIR)) return {};
  const out = {};
  for (const f of fs.readdirSync(PHOTO_DIR)) {
    const m = /^([a-z]+)\.(png|jpg|webp)$/.exec(f); if (!m) continue;
    out[m[1]] = `/photos/${f}?v=${Math.round(fs.statSync(path.join(PHOTO_DIR, f)).mtimeMs)}`;
  }
  return out;
}
function saveCustomPhoto(name, dataUrl) {
  const key = normName(name); if (!key) throw new Error('player has no name');
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  for (const ext of Object.keys(PHOTO_TYPES)) fs.rmSync(path.join(PHOTO_DIR, `${key}.${ext}`), { force: true });
  if (!dataUrl) return; // removal
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('Pick a PNG, JPG or WebP image');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 5e6) throw new Error('Image is too large (5 MB max)');
  fs.writeFileSync(path.join(PHOTO_DIR, `${key}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`), bytes);
}

// Madden lists a roster by the text after the last dash in its file name, so new names are letters and digits only
function rosterPath(raw) {
  const name = String(raw ?? '').replace(/^ROSTER-/i, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  if (!name) throw new Error('Enter a name for the new roster');
  return path.join(savesDir, 'ROSTER-' + name);
}
const legendsFile = () => listRosters().map(r => r.name).find(n => /legend/i.test(n));

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
const readBody = req => new Promise((ok, fail) => { let s = ''; req.on('data', c => { s += c; if (s.length > 20e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fail(e); } }); });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, loadUi(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/rosters') return send(res, 200, JSON.stringify({ savesDir, rosters: listRosters() }));
    if (req.method === 'POST' && url.pathname === '/api/saves-dir') {
      const { dir } = await readBody(req);
      if (!dir || !fs.existsSync(dir)) return send(res, 400, JSON.stringify({ error: 'That folder does not exist' }));
      savesDir = dir; cache.clear();
      return send(res, 200, JSON.stringify({ savesDir, rosters: listRosters() }));
    }
    if (req.method === 'GET' && url.pathname === '/api/headshots') {
      try { return send(res, 200, JSON.stringify((await loadHeadshots()).byName)); }
      catch (e) { return send(res, 200, JSON.stringify({ offline: e.message })); }
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const { files, releaseMissing } = await readBody(req);
      const nfl = await fetchNfl();
      const stamp = new Date().toISOString().slice(5, 10).replace('-', '');
      const results = [];
      for (const f of files ?? []) {
        const name = path.basename(f);
        const stem = name.replace(/^ROSTER-/i, '').replace(/[^A-Za-z0-9]/g, '').replace(/SYNC\d{4}$/, '').slice(0, 16);
        const out = rosterPath(`${stem}SYNC${stamp}`);
        try {
          const n = syncRoster(path.join(savesDir, name), out, nfl, { releaseMissing });
          results.push({ base: name, file: path.basename(out), moved: n.moved, released: n.released, injured: n.injured.length, injuries: n.injured });
        } catch (e) { results.push({ base: name, error: e.message }); }
      }
      return send(res, 200, JSON.stringify({ fetched: nfl.fetched, results }));
    }
    if (req.method === 'GET' && url.pathname === '/api/roster') return send(res, 200, rosterInfo(url.searchParams.get('file')));
    if (req.method === 'GET' && url.pathname === '/api/legends') {
      const file = legendsFile();
      if (!file) return send(res, 404, JSON.stringify({ error: 'No legends roster found. Put a ROSTER file with "Legends" in its name in your saves folder.' }));
      const base = path.join(savesDir, path.basename(url.searchParams.get('base') ?? ''));
      const players = summarizeLegends(path.join(savesDir, file), base);
      prefetchAll(players.map(p => `${p.PFNA} ${p.PLNA}`)).catch(() => {}); // photos for every franchise's legends
      return send(res, 200, JSON.stringify({ file, players, photos: cachedPhotos() }));
    }
    if (req.method === 'POST' && url.pathname === '/api/export') {
      const body = await readBody(req);
      const out = rosterPath(body.outName);
      const legends = legendsFile();
      const result = exportRoster(path.join(savesDir, path.basename(body.base)), out, { ...body, legendsFile: legends && path.join(savesDir, legends) });
      return send(res, 200, JSON.stringify({ ...result, file: path.basename(out) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/custom-photos') return send(res, 200, JSON.stringify(customPhotos()));
    if (req.method === 'POST' && url.pathname === '/api/custom-photo') {
      const { name, dataUrl } = await readBody(req);
      saveCustomPhoto(name, dataUrl);
      return send(res, 200, JSON.stringify(customPhotos()));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
      const f = path.basename(url.pathname);
      const ext = /\.(png|jpg|webp)$/.exec(f)?.[1];
      const full = path.join(PHOTO_DIR, f);
      if (!ext || !fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), PHOTO_TYPES[ext]);
    }
    if (req.method === 'POST' && url.pathname === '/api/legend-photos') {
      const { names } = await readBody(req);
      return send(res, 200, JSON.stringify(await legendPhotos((names ?? []).map(String).slice(0, 60))));
    }
    if (req.method === 'POST' && url.pathname === '/api/league') {
      const body = await readBody(req);
      const out = rosterPath(body.outName);
      const result = leagueChaos(path.join(savesDir, path.basename(body.base)), out, body.op);
      return send(res, 200, JSON.stringify({ ...result, file: path.basename(out) }));
    }
    send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }));
  }
});

server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is Roster Builder already open?` : e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Madden 27 Roster Builder running at ${url}`);
  console.log(`Saves folder: ${savesDir}`);
  console.log('Close this window to quit.');
  if (!OPEN) return;
  // app-style window in Edge if available, otherwise the default browser
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
  if (edge) execFile(edge, [`--app=${url}`, '--window-size=1500,950'], () => {});
  else execFile('cmd', ['/c', 'start', '', url], () => {});
});
