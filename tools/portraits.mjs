// Rebuild lib/portraits.json (Madden 27 headshot id by player name) from the game's portrait library.
// Maintainer tool: needs the game, MMC's cache and the asset readers in madden27-qb-vision/tools (set M27TOOLS, and M27 to the game folder).
//   node tools/portraits.mjs
import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawnSync } from 'child_process'; import { pathToFileURL, fileURLToPath } from 'url';
if (!process.env.M27TOOLS || !process.env.M27) { console.error('set M27TOOLS to the folder with frosty-cache.mjs, sdk.mjs and ebx.mjs'); process.exit(1); }
const T = pathToFileURL(process.env.M27TOOLS + '/').href;
const { loadIndex, casFile, MMC } = await import(T + 'frosty-cache.mjs');
const { loadAttrs, layoutOf } = await import(T + 'sdk.mjs');
const { openEbx, readInstance } = await import(T + 'ebx.mjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portraits-'));
const list = loadIndex().ebx.filter(e => /playerportraits\/assets\/(legends\/)?plpo_[^/]*$/i.test(e.name) && !/_assetlibrary/i.test(e.name) && e.cas);
fs.writeFileSync(path.join(dir, 'list.tsv'), list.map((e, i) => [casFile(e.cas), e.off, e.size, e.osize, path.join(dir, i + '.ebx')].join('\t')).join('\n'));
const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'batchread.ps1'), '-List', path.join(dir, 'list.tsv'), '-Oodle', path.join(process.env.M27, 'oo2core_9_win64.dll')], { encoding: 'utf8', maxBuffer: 1e8 });
if (r.stdout.trim()) console.error(r.stdout.trim());
const A = loadAttrs(`${MMC}/Profiles/MADDEN27SDK.dll`), L = {}, out = { legend: {}, player: {} };
list.forEach((e, i) => {
  const R = openEbx(path.join(dir, i + '.ebx')), ids = readInstance(R, R.dc[0], L[e.type] ??= layoutOf(A, e.type)).AssetIdList;
  if (ids?.length !== 1) return;
  // legend names vary: lastfirst, firstlast, a _profile suffix, a trailing number; keep letters only, plain names win
  const raw = e.name.split('/').pop().replace(/^plpo_(legends_)?/i, ''), key = raw.replace(/_profile$|\d+$|_player$/i, '').replace(/[^a-z]/gi, '').toLowerCase();
  const m = out[/\/legends\//i.test(e.name) ? 'legend' : 'player'];
  if (!(key in m) || raw.toLowerCase() === key) m[key] = ids[0];
});
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync(path.join(here, '..', 'lib', 'portraits.json'), JSON.stringify(out));
console.log(`portraits.json: ${Object.keys(out.legend).length} legends, ${Object.keys(out.player).length} players`);
