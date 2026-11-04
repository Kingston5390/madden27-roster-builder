// Photos for players ESPN's current rosters don't cover (legends, free agents, created players): ESPN player search
// first, then Wikipedia. Draft prospects use ESPN college football. Anyone still without one gets a silhouette in the app.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CACHE = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder', 'legend-photos.json');
let cache = null;
const CACHE_VERSION = 2; // 2: Wikipedia photos must be of American football players, so older Wikipedia picks are looked up again
const load = () => {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { cache = {}; }
  if (cache.__v !== CACHE_VERSION) {
    for (const [k, v] of Object.entries(cache)) if (/wikimedia/.test(v ?? '')) delete cache[k];
    cache.__v = CACHE_VERSION; persist();
  }
  return cache;
};
const persist = () => { try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch {} };

// ESPN league ids: 28 is the NFL, 23 is college football
async function fromEspn(name, league = 28) {
  const r = await (await fetch(`https://site.web.api.espn.com/apis/search/v2?limit=8&type=player&query=${encodeURIComponent(name)}`)).json();
  const hit = (r.results ?? []).flatMap(x => x.contents ?? []).find(c => new RegExp(`~l:${league}~`).test(c.uid ?? '') && c.image?.default);
  return hit?.image.default ?? null;
}

// draft prospects are college players: ESPN college football headshots, cached under their own key
async function prospectPhotos(names) {
  const c = load();
  const todo = [...new Set(names)].filter(n => !(`cfb:${n}` in c)).slice(0, 60);
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) { const n = todo[i++]; try { c[`cfb:${n}`] = await fromEspn(n, 23); } catch { /* offline: retry later */ } }
  }));
  if (todo.length) persist();
  return Object.fromEntries(names.map(n => [n, c[`cfb:${n}`] ?? null]));
}

async function fromWikipedia(name) {
  for (const title of [`${name} (American football)`, name]) {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { headers: { 'user-agent': 'MaddenRosterBuilder/1.0' } });
    if (!res.ok) continue;
    const w = await res.json(), d = w.description ?? '';
    // American football only: "English footballer" or "rugby football" pages are someone else
    if (/football/i.test(d) && !/footballer|association football|soccer|rugby|australian rules|gaelic/i.test(d) && w.thumbnail?.source) return w.thumbnail.source;
  }
  return null;
}

// name -> photo url or null; cached so each name is looked up once
async function playerPhotos(names, limit = 40) {
  const c = load();
  const todo = [...new Set(names)].filter(n => !(n in c)).slice(0, limit);
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) {
      const n = todo[i++];
      try { c[n] = (await fromEspn(n)) ?? (await fromWikipedia(n)); } catch { /* offline: try again next time */ }
    }
  }));
  if (todo.length) persist();
  return Object.fromEntries(names.map(n => [n, c[n] ?? null]));
}

// look up every legend once in the background (saved as it goes), so every franchise has photos ready
let prefetching = null;
function prefetchAll(names) {
  if (prefetching) return prefetching;
  prefetching = (async () => {
    const all = [...new Set(names)];
    for (let i = 0; i < all.length; i += 40) await playerPhotos(all.slice(i, i + 40), 40);
  })().finally(() => { prefetching = null; });
  return prefetching;
}
const cachedPhotos = () => { const { __v, ...photos } = load(); return photos; };

module.exports = { playerPhotos, prospectPhotos, prefetchAll, cachedPhotos };
