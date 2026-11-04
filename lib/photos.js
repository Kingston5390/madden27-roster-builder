// Photos for legends (retired players aren't on current NFL rosters): ESPN player search first, then Wikipedia.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CACHE = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder', 'legend-photos.json');
let cache = null;
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { cache = {}; } } return cache; };
const persist = () => { try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch {} };

async function fromEspn(name) {
  const r = await (await fetch(`https://site.web.api.espn.com/apis/search/v2?limit=5&type=player&query=${encodeURIComponent(name)}`)).json();
  // league 28 is the NFL
  const hit = (r.results ?? []).flatMap(x => x.contents ?? []).find(c => /~l:28~/.test(c.uid ?? '') && c.image?.default);
  return hit?.image.default ?? null;
}

async function fromWikipedia(name) {
  for (const title of [`${name} (American football)`, name]) {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { headers: { 'user-agent': 'MaddenRosterBuilder/1.0' } });
    if (!res.ok) continue;
    const w = await res.json();
    if (/football/i.test(w.description ?? '') && w.thumbnail?.source) return w.thumbnail.source;
  }
  return null;
}

// name -> photo url or null; cached so each name is looked up once
async function legendPhotos(names, limit = 40) {
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
    for (let i = 0; i < all.length; i += 40) await legendPhotos(all.slice(i, i + 40), 40);
  })().finally(() => { prefetching = null; });
  return prefetching;
}
const cachedPhotos = () => ({ ...load() });

module.exports = { legendPhotos, prefetchAll, cachedPhotos };
