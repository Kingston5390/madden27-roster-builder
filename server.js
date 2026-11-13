// Madden 27 Roster Builder: local server + UI. Runs as `node server.js` or packaged as RosterBuilder.exe.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const { summarize, summarizeLegends, exportRoster } = require('./lib/roster');
const { leagueChaos, applyTrades } = require('./lib/league');
const { playerPhotos, prospectPhotos, prefetchAll, cachedPhotos } = require('./lib/photos');
const { readDraftClass, writeDraftClass } = require('./lib/draft');
const { summarizeFranchise, applyFranchiseEdits } = require('./lib/franchise');
const { searchCollegePlayers } = require('./lib/college');
const { fetchNfl, syncRoster, normName } = require('./lib/sync');

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(flag('--port') ?? 8790);
const OPEN = !args.includes('--no-open');
const VERSION = '1.2.4'; // keep in step with package.json
const APP_DIR = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder');

// The exe has no console window, so what it would print also goes to a log file (newest run at the bottom)
const IS_EXE = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
if (IS_EXE) {
  const LOG = path.join(APP_DIR, 'log.txt');
  try { fs.mkdirSync(APP_DIR, { recursive: true }); if (fs.statSync(LOG, { throwIfNoEntry: false })?.size > 1e6) fs.rmSync(LOG); } catch {}
  const toLog = (...a) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {} };
  const out = console.log, err = console.error;
  console.log = (...a) => { toLog(...a); out(...a); };
  console.error = (...a) => { toLog('ERROR', ...a); err(...a); };
  process.on('uncaughtException', e => { console.error(e.stack || e.message); process.exit(1); });
}

// Close the window, close the app: the page checks in every 10 seconds, and says goodbye when it closes. With no window
// left (no check-in for 75 seconds, which allows for browsers slowing down minimized windows, or 10 seconds after
// a goodbye with nothing since), the app quits.
let lastPing = 0, byeAt = 0;
function watchWindows() {
  setInterval(() => {
    const now = Date.now();
    if (!lastPing) return; // no window has opened yet
    if (now - lastPing > 75000 || (byeAt > lastPing && now - byeAt > 10000)) { console.log('App window closed; quitting.'); process.exit(0); }
  }, 5000).unref();
}

// the saves folder you picked is remembered between launches
const SETTINGS = path.join(APP_DIR, 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const writeSettings = s => { try { fs.mkdirSync(APP_DIR, { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify({ ...readSettings(), ...s })); } catch { /* not remembered */ } };

// Madden keeps saves in Documents\Madden NFL 27\saves, but Documents is often elsewhere (OneDrive, another drive), so ask Windows
function documentsFolders() {
  const out = [];
  if (process.platform === 'win32') {
    try {
      const reg = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'], { encoding: 'utf8', windowsHide: true });
      const m = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(reg);
      if (m) out.push(m[1].trim().replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all));
    } catch { /* fall back to the usual places */ }
  }
  for (const od of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) if (od) out.push(path.join(od, 'Documents'));
  out.push(path.join(os.homedir(), 'Documents'));
  return [...new Set(out)];
}
function findSavesDir() {
  const dirs = documentsFolders().map(d => path.join(d, 'Madden NFL 27', 'saves'));
  const hasSaves = d => { try { return fs.readdirSync(d).some(f => /^(ROSTER|CAREER)/.test(f)); } catch { return false; } };
  return dirs.find(hasSaves) ?? dirs.find(d => fs.existsSync(d)) ?? dirs[0];
}
const remembered = readSettings().savesDir;
let savesDir = flag('--saves') ?? (remembered && fs.existsSync(remembered) ? remembered : findSavesDir());
// nothing in the usual places: search this PC once (a few seconds at most) for a saves folder that has files
if (!flag('--saves')) { const c = savesCounts(savesDir); if (!c || !(c.rosters + c.drafts + c.franchises)) savesDir = searchSaves().find(f => f.rosters + f.drafts + f.franchises)?.path ?? savesDir; }

// The folder browser lives in the app window (a Windows dialog started from here can open hidden behind it).
// What a folder holds: Madden files counted, so the browser can point at the right one
function savesCounts(dir) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return null; }
  return { rosters: files.filter(f => /^ROSTER-/.test(f)).length, drafts: files.filter(f => /^CAREERDRAFT-/.test(f)).length, franchises: files.filter(f => /^CAREER-/.test(f)).length };
}
function listFolder(dir) {
  if (!dir) { // top level: drives
    const drives = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`).filter(d => fs.existsSync(d)) : ['/'];
    return { dir: '', parent: null, folders: drives.map(d => ({ name: d, path: d })), counts: null };
  }
  const folders = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !/^\$|^System Volume Information$/i.test(e.name)) folders.push({ name: e.name, path: path.join(dir, e.name) });
  } catch (err) { throw new Error(`Can't open ${dir}: ${err.code === 'EPERM' || err.code === 'EACCES' ? 'no permission' : err.code ?? err.message}`); }
  const parent = path.dirname(dir);
  return { dir, parent: parent === dir ? '' : parent, folders: folders.sort((a, b) => a.name.localeCompare(b.name)), counts: savesCounts(dir) };
}
// every "Madden NFL 27\saves" in the usual Documents folders, then anywhere a few levels under the user folder and drive roots
function searchSaves() {
  const found = new Map();
  const check = d => { const c = savesCounts(d); if (c) found.set(d.toLowerCase(), { path: d, ...c }); };
  for (const d of documentsFolders()) check(path.join(d, 'Madden NFL 27', 'saves'));
  const deadline = Date.now() + 4000;
  const walk = (dir, depth) => {
    if (depth < 0 || Date.now() > deadline) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || /^(\$|\.|node_modules$|Windows$|Program Files|ProgramData$|AppData$)/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (/^Madden NFL 27$/i.test(e.name)) check(path.join(full, 'saves'));
      else walk(full, depth - 1);
    }
  };
  walk(os.homedir(), 4);
  if (process.platform === 'win32') for (const l of 'CDEFGH') if (fs.existsSync(`${l}:\\`)) walk(`${l}:\\`, 2);
  return [...found.values()].sort((a, b) => (b.rosters + b.drafts + b.franchises) - (a.rosters + a.drafts + a.franchises));
}

// from the exe's embedded assets, or the source tree when run with node
function bundled(asset, file) {
  try { const sea = require('node:sea'); if (sea.isSea()) return sea.getAsset(asset, 'utf8'); } catch {}
  return fs.readFileSync(path.join(__dirname, file), 'utf8');
}
const loadUi = () => bundled('index.html', path.join('ui', 'index.html'));

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

// Your own intro clips: any .mp4/.webm here joins the random intro rotation (local only)
const INTRO_DIR = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder', 'intros');
const INTRO_TYPES = { mp4: 'video/mp4', webm: 'video/webm' };
const listIntros = () => fs.existsSync(INTRO_DIR) ? fs.readdirSync(INTRO_DIR).filter(f => /\.(mp4|webm)$/i.test(f)) : [];

// Madden lists a roster by the text after the last dash in its file name, so new names are letters and digits only
function rosterPath(raw) {
  const name = String(raw ?? '').replace(/^ROSTER-/i, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  if (!name) throw new Error('Enter a name for the new roster');
  return path.join(savesDir, 'ROSTER-' + name);
}
const legendsFile = () => listRosters().map(r => r.name).find(n => /legend/i.test(n));
const listDrafts = () => fs.existsSync(savesDir) ? fs.readdirSync(savesDir).filter(f => /^CAREERDRAFT-/.test(f))
  .map(f => ({ name: f, modified: fs.statSync(path.join(savesDir, f)).mtimeMs })).sort((a, b) => a.name.localeCompare(b.name)) : [];
// franchise saves are CAREER-<name> (draft classes are CAREERDRAFT-, so they never match)
const listFranchises = () => fs.existsSync(savesDir) ? fs.readdirSync(savesDir).filter(f => /^CAREER-/.test(f))
  .map(f => ({ name: f, modified: fs.statSync(path.join(savesDir, f)).mtimeMs })).sort((a, b) => b.modified - a.modified) : [];
const franchiseCache = new Map();
async function franchiseInfo(file) {
  const full = path.join(savesDir, path.basename(file));
  const mtime = fs.statSync(full).mtimeMs;
  const hit = franchiseCache.get(full);
  if (hit && hit.mtime === mtime) return hit.json;
  // modified lets the app drop saved edits once Madden rewrites the file (row numbers can move)
  const json = JSON.stringify({ ...(await summarizeFranchise(full)), modified: mtime });
  franchiseCache.set(full, { mtime, json });
  return json;
}

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
const readBody = req => new Promise((ok, fail) => { let s = ''; req.on('data', c => { s += c; if (s.length > 20e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fail(e); } }); });

let latestRelease = null;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, loadUi(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/licenses') return send(res, 200, bundled('THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'), 'text/plain; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, JSON.stringify({ version: VERSION }));
    if (url.pathname === '/api/ping') { lastPing = Date.now(); return send(res, 200, '{}'); }
    if (url.pathname === '/api/bye') { byeAt = Date.now(); return send(res, 200, '{}'); }
    // newest release on GitHub, so the app can say when a new version is out (asked once per launch)
    if (req.method === 'GET' && url.pathname === '/api/latest') {
      latestRelease ??= fetch('https://api.github.com/repos/Kingston5390/madden27-roster-builder/releases/latest', { headers: { 'user-agent': 'MaddenRosterBuilder' } })
        .then(r => r.json()).then(j => ({ version: String(j.tag_name ?? '').replace(/^v/, ''), url: j.html_url })).catch(() => ({}));
      const latest = await latestRelease;
      const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
      return send(res, 200, JSON.stringify({ current: VERSION, latest: latest.version ?? null, url: latest.url ?? null, update: !!latest.version && newer(latest.version, VERSION) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/rosters') return send(res, 200, JSON.stringify({ savesDir, exists: fs.existsSync(savesDir), counts: savesCounts(savesDir), rosters: listRosters() }));
    if (req.method === 'GET' && url.pathname === '/api/folders') {
      let dir = url.searchParams.get('dir') ?? '';
      // nearest: start from the closest folder that exists (the saves path may not)
      if (url.searchParams.has('nearest')) while (dir && !fs.existsSync(dir)) dir = path.dirname(dir) === dir ? '' : path.dirname(dir);
      return send(res, 200, JSON.stringify(listFolder(dir)));
    }
    if (req.method === 'GET' && url.pathname === '/api/find-saves') return send(res, 200, JSON.stringify({ found: searchSaves() }));
    if (req.method === 'POST' && url.pathname === '/api/saves-dir') {
      const { dir } = await readBody(req);
      if (!dir || !fs.existsSync(dir)) return send(res, 400, JSON.stringify({ error: 'That folder does not exist' }));
      savesDir = dir; cache.clear(); writeSettings({ savesDir });
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
        const stem = name.replace(/^ROSTER-/i, '').replace(/[^A-Za-z0-9]/g, '').replace(/SYNC\d{4}[A-Z]?$/, '').slice(0, 16);
        // synced twice in a day: ...SYNC1113B, C, ... instead of failing on the existing file
        let out = rosterPath(`${stem}SYNC${stamp}`);
        for (let n = 1; fs.existsSync(out) && n < 26; n++) out = rosterPath(`${stem}SYNC${stamp}${String.fromCharCode(65 + n)}`);
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
    if (req.method === 'GET' && url.pathname === '/api/intros') return send(res, 200, JSON.stringify({ videos: listIntros() }));
    if (req.method === 'GET' && url.pathname.startsWith('/intros/')) {
      const f = path.basename(decodeURIComponent(url.pathname.slice(8)));
      const ext = /\.(mp4|webm)$/i.exec(f)?.[1]?.toLowerCase();
      const full = path.join(INTRO_DIR, f);
      if (!ext || !fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'content-type': INTRO_TYPES[ext], 'content-length': fs.statSync(full).size });
      return fs.createReadStream(full).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/open-intros') {
      fs.mkdirSync(INTRO_DIR, { recursive: true });
      execFile('explorer.exe', [INTRO_DIR], () => {});
      return send(res, 200, JSON.stringify({ dir: INTRO_DIR }));
    }
    if (req.method === 'GET' && url.pathname === '/api/drafts') return send(res, 200, JSON.stringify({ savesDir, drafts: listDrafts() }));
    if (req.method === 'GET' && url.pathname === '/api/draft') {
      return send(res, 200, JSON.stringify(readDraftClass(path.join(savesDir, path.basename(url.searchParams.get('file') ?? '')))));
    }
    if (req.method === 'POST' && url.pathname === '/api/draft-export') {
      const body = await readBody(req);
      const name = String(body.outName ?? '').replace(/^CAREERDRAFT-/i, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
      if (!name) throw new Error('Enter a name for the new draft class');
      const out = path.join(savesDir, 'CAREERDRAFT-' + name);
      const result = writeDraftClass(path.join(savesDir, path.basename(body.base)), out, body.edits, Array.isArray(body.added) ? body.added : []);
      return send(res, 200, JSON.stringify({ ...result, file: path.basename(out) }));
    }
    // Madden's college numbers -> [name, ESPN team id], built by tools/build-colleges.js
    if (req.method === 'GET' && url.pathname === '/api/colleges') return send(res, 200, bundled('colleges.json', path.join('lib', 'colleges.json')));
    if (req.method === 'GET' && url.pathname === '/api/college-players') {
      const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 60);
      return send(res, 200, JSON.stringify(q ? await searchCollegePlayers(q) : []));
    }
    if (req.method === 'GET' && url.pathname === '/api/franchises') return send(res, 200, JSON.stringify({ savesDir, franchises: listFranchises() }));
    if (req.method === 'GET' && url.pathname === '/api/franchise') return send(res, 200, await franchiseInfo(url.searchParams.get('file') ?? ''));
    if (req.method === 'POST' && url.pathname === '/api/franchise-export') {
      const body = await readBody(req);
      // same rule as rosters: letters and digits only after CAREER-
      const name = String(body.outName ?? '').replace(/^CAREER-/i, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
      if (!name) throw new Error('Enter a name for the new franchise save');
      const out = path.join(savesDir, 'CAREER-' + name);
      const result = await applyFranchiseEdits(path.join(savesDir, path.basename(body.base)), out, body.edits ?? {});
      return send(res, 200, JSON.stringify(result));
    }
    if (req.method === 'POST' && url.pathname === '/api/prospect-photos') {
      const { names } = await readBody(req);
      return send(res, 200, JSON.stringify(await prospectPhotos((names ?? []).map(String).slice(0, 80))));
    }
    if (req.method === 'POST' && url.pathname === '/api/player-photos') {
      const { names } = await readBody(req);
      return send(res, 200, JSON.stringify(await playerPhotos((names ?? []).map(String).slice(0, 60))));
    }
    if (req.method === 'POST' && url.pathname === '/api/trades') {
      const body = await readBody(req);
      const out = rosterPath(body.outName);
      const result = applyTrades(path.join(savesDir, path.basename(body.base)), out, body.moves);
      return send(res, 200, JSON.stringify({ ...result, file: path.basename(out) }));
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

// app-style window: Chrome first (it's kept up to date; some PCs have an old, locked Edge the app can't run in),
// then Edge, otherwise the default browser
function openWindow(url) {
  const local = process.env.LOCALAPPDATA || '';
  const browsers = [
    ['chrome', ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', path.join(local, 'Google\\Chrome\\Application\\chrome.exe')]],
    ['edge', ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']],
  ];
  for (const [name, paths] of browsers) {
    const exe = paths.find(p => fs.existsSync(p));
    if (!exe) continue;
    // own profile: a separate browser process, so the flag letting the intro play sound before the first click always applies
    const profile = path.join(APP_DIR, `${name}-profile`);
    console.log(`Opening the app window in ${name === 'chrome' ? 'Chrome' : 'Edge'}. If it looks broken, paste ${url} into any browser.`);
    return execFile(exe, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1500,950', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check'], () => {});
  }
  execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

let port = PORT;
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') { console.error(e.message); process.exit(1); }
  // opened twice: if that copy is this same version, just show its window. An older copy keeps its port and this one moves on.
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/version`);
    if (r.ok && (await r.json()).version === VERSION) {
      console.log('Roster Builder is already running.');
      if (OPEN) openWindow(`http://127.0.0.1:${port}/`);
      return setTimeout(() => process.exit(0), 1500);
    }
  } catch { /* an older copy or another program has the port */ }
  if (port >= PORT + 10) { console.error(`Ports ${PORT} to ${port} are all in use.`); process.exit(1); }
  server.listen(++port, '127.0.0.1');
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Madden 27 Roster Builder ${VERSION} running at ${url}`);
  console.log(`Saves folder: ${savesDir}`);
  console.log('Closing the app window quits.');
  if (OPEN) { openWindow(url); watchWindows(); }
});
server.listen(port, '127.0.0.1');
