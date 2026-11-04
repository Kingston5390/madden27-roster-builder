// Builds lib/colleges.json: Madden's college numbers (PCOL in rosters, "college" in draft classes) -> [name, ESPN team id].
// Madden stores a college as a number only. Two sources name them: roster players matched to ESPN's NFL rosters (which
// list each player's college), and draft prospects matched to ESPN college football players (whose school ESPN shows).
// Usage: node tools/build-colleges.js <ROSTER file> [CAREERDRAFT files...]   (DUMP_VOTES=file.json keeps the raw votes)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readRosterFile } = require('../lib/tdb2');
const { readDraftClass } = require('../lib/draft');

const NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CFB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const norm = s => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const getJson = async url => (await fetch(url)).json();

async function main() {
  const [rosterFile, ...draftFiles] = process.argv.slice(2);
  if (!rosterFile) throw new Error('usage: node tools/build-colleges.js <ROSTER file> [CAREERDRAFT files...]');
  // every ESPN college team by display name ("Ohio State Buckeyes"), which is how its search labels a player's school
  const schools = new Map();
  for (const t of (await getJson(`${CFB}/teams?limit=2000`)).sports[0].leagues[0].teams.map(x => x.team))
    schools.set(t.displayName, { id: Number(t.id), name: t.location });
  const votes = new Map(); // college number -> Map(school key -> { name, espn, n })
  const vote = (num, school) => {
    const m = votes.get(num) ?? votes.set(num, new Map()).get(num);
    const key = school.id ?? school.name;
    (m.get(key) ?? m.set(key, { name: school.name, espn: school.id, n: 0 }).get(key)).n++;
  };

  // 1. NFL players: ESPN roster entries carry a college
  const espnByName = new Map();
  for (const t of (await getJson(`${NFL}/teams`)).sports[0].leagues[0].teams.map(x => x.team))
    for (const a of (await getJson(`${NFL}/teams/${t.id}/roster`)).athletes.flatMap(g => g.items ?? [])) {
      if (!a.college?.name) continue;
      const k = norm(a.fullName);
      (espnByName.get(k) ?? espnByName.set(k, []).get(k)).push(a.college);
    }
  let matched = 0;
  for (const p of readRosterFile(rosterFile).data.PLAY) {
    const hits = espnByName.get(norm(`${p.PFNA} ${p.PLNA}`));
    if (hits?.length !== 1) continue; // unknown, or a name several players share
    vote(p.PCOL ?? 0, { id: Number(hits[0].id), name: hits[0].name }); matched++;
  }
  console.log(`roster: ${matched} players matched`);

  // 2. draft prospects: ESPN college football search shows each player's current school
  const prospects = draftFiles.flatMap(f => readDraftClass(f).prospects);
  let i = 0, found = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < prospects.length) {
      const p = prospects[i++], name = `${p.firstName} ${p.lastName}`;
      try {
        const r = await getJson(`https://site.web.api.espn.com/apis/search/v2?limit=10&type=player&query=${encodeURIComponent(name)}`);
        const hits = (r.results ?? []).flatMap(x => x.contents ?? []).filter(c => /~l:23~/.test(c.uid ?? '') && norm(c.displayName) === norm(name) && c.subtitle);
        if (hits.length !== 1) continue; // nobody, or several college players with that name
        vote(p.college, schools.get(hits[0].subtitle) ?? { id: null, name: hits[0].subtitle });
        found++;
      } catch { /* network hiccup: that prospect just doesn't vote */ }
    }
  }));
  console.log(`draft classes: ${found} of ${prospects.length} prospects matched`);
  if (process.env.DUMP_VOTES) fs.writeFileSync(process.env.DUMP_VOTES, JSON.stringify(Object.fromEntries([...votes].map(([k, m]) => [k, [...m.values()]]))));

  // each number takes its clear winner; a close call is left out rather than guessed
  const winners = [];
  for (const [num, m] of votes) {
    const [best, next] = [...m.values()].sort((a, b) => b.n - a.n);
    const total = [...m.values()].reduce((s, v) => s + v.n, 0);
    if ((next && best.n < 2 * next.n) || best.n / total < 0.6) { console.log(`college ${num}: unclear (${[...m.values()].map(v => `${v.name} ${v.n}`).join(', ')})`); continue; }
    winners.push({ num, ...best });
  }
  // a school can only be one number: the best-supported one keeps the name, and a tie names neither
  const out = {};
  for (const w of winners) {
    const rivals = winners.filter(x => x.name === w.name && x !== w);
    if (rivals.some(x => x.n >= w.n)) { if (rivals.some(x => x.n === w.n)) console.log(`college ${w.num}: ${w.name} is also ${rivals.map(x => x.num).join(', ')}`); continue; }
    out[w.num] = w.espn ? [w.name, w.espn] : [w.name];
  }
  fs.writeFileSync(path.join(__dirname, '..', 'lib', 'colleges.json'), JSON.stringify(out) + '\n');
  console.log(`wrote lib/colleges.json: ${Object.keys(out).length} colleges`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
