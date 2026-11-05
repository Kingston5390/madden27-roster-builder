// Madden 27 Roster Builder: local server + UI. Runs as `node server.js` or packaged as RosterBuilder.exe.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const { summarize, summarizeLegends, exportRoster } = require('./lib/roster');
const { leagueChaos } = require('./lib/league');
const { playerPhotos, prospectPhotos, prefetchAll, cachedPhotos } = require('./lib/photos');
const { readDraftClass, writeDraftClass } = require('./lib/draft');
const { summarizeFranchise, applyFranchiseEdits } = require('./lib/franchise');
const { searchCollegePlayers } = require('./lib/college');
const { fetchNfl, syncRoster, normName } = require('./lib/sync');

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(flag('--port') ?? 8790);
const OPEN = !args.includes('--no-open');
const APP_DIR = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder');

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

// Windows' own folder picker (PowerShell + WinForms), kept above the app window.
// Resolves to the folder, null when cancelled, or undefined when the picker couldn't open (the app then asks for a path).
function pickFolder(start) {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose your Madden NFL 27 saves folder (the one with your ROSTER files)'
if (Test-Path -LiteralPath $env:RB_START) { $d.SelectedPath = $env:RB_START }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`;
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { env: { ...process.env, RB_START: start }, windowsHide: true },
    (err, stdout) => resolve(err ? undefined : String(stdout).trim() || null)));
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, loadUi(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/licenses') return send(res, 200, bundled('THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'), 'text/plain; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/rosters') return send(res, 200, JSON.stringify({ savesDir, rosters: listRosters() }));
    if (req.method === 'POST' && url.pathname === '/api/saves-dir') {
      let { dir, pick } = await readBody(req);
      if (pick) {
        dir = await pickFolder(savesDir);
        if (dir === undefined) return send(res, 200, JSON.stringify({ unavailable: true, savesDir }));
        if (dir === null) return send(res, 200, JSON.stringify({ cancelled: true, savesDir }));
      }
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

// app-style window in Edge if available, otherwise the default browser
function openWindow(url) {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
  // own Edge profile: a separate Edge process, so the flag letting the intro play sound before the first click always applies
  const profile = path.join(APP_DIR, 'edge-profile');
  if (edge) execFile(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1500,950', '--autoplay-policy=no-user-gesture-required', '--no-first-run'], () => {});
  else execFile('cmd', ['/c', 'start', '', url], () => {});
}

let port = PORT;
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') { console.error(e.message); process.exit(1); }
  // opened twice: the first copy is still running, so just show its window
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/rosters`);
    if (r.ok && Array.isArray((await r.json()).rosters)) {
      console.log('Roster Builder is already running.');
      if (OPEN) openWindow(`http://127.0.0.1:${port}/`);
      return setTimeout(() => process.exit(0), 1500);
    }
  } catch { /* something else has the port */ }
  if (port >= PORT + 10) { console.error(`Ports ${PORT} to ${port} are all in use.`); process.exit(1); }
  server.listen(++port, '127.0.0.1');
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Madden 27 Roster Builder running at ${url}`);
  console.log(`Saves folder: ${savesDir}`);
  console.log('Close this window to quit.');
  if (OPEN) openWindow(url);
});
server.listen(port, '127.0.0.1');
