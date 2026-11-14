// Sync a roster with the real NFL: current team for every player (trades, signings) and current injuries, from ESPN.
'use strict';
const fs = require('node:fs');
const { readRosterFile, buildRosterFile, encodePayload, decodePayload, readAppearance, writeAppearance } = require('./tdb2');

const API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
// ESPN abbreviation -> roster team id (ids are fixed even when a team is renamed in the file)
const TEAM_ID = { CHI: 1, CIN: 2, BUF: 3, DEN: 4, CLE: 5, TB: 6, ARI: 7, LAC: 8, KC: 9, IND: 10, DAL: 11, MIA: 12, PHI: 13, ATL: 14, SF: 15, NYG: 16,
  JAX: 17, NYJ: 18, DET: 19, GB: 20, CAR: 21, NE: 22, LV: 23, LAR: 24, BAL: 25, WSH: 26, NO: 27, SEA: 28, PIT: 29, TEN: 30, MIN: 31, HOU: 32 };
// injury body part -> EA injury type code (learned from EA's own roster files)
const INJURY_TYPE = { ankle: 6, foot: 31, heel: 31, biceps: 13, 'upper body': 13, forearm: 13, knee: 58, neck: 18, hip: 51, spine: 25,
  quadriceps: 77, 'lower body': 77, leg: 77, achilles: 5, hamstring: 75, 'lower leg': 39, shin: 39, fibula: 73, core: 84, abdomen: 84,
  groin: 74, concussion: 79, head: 79, thumb: 38, finger: 38, hand: 38, wrist: 38, back: 23, elbow: 23, toe: 29, illness: 29, calf: 72, thigh: 72,
  pectoral: 87, chest: 87, ribs: 87, shoulder: 92, triceps: 14 };
const OTHER_INJURY = 31;
const OUT_STATUSES = new Set(['Injured Reserve', 'Out', 'Physically Unable to Perform', 'Non-Football Injury', 'Suspension']);

const normName = s => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const tg = r => r.TGID ?? 0;
const pos = r => r.PPOS ?? 0;
const dep = r => r.DDEP ?? 0;
const set = (r, k, v) => { if (v === 0) delete r[k]; else r[k] = v; };

let cached = null;
async function fetchNfl() {
  if (cached && Date.now() - cached.fetched < 30 * 60e3) return cached;
  const teams = (await (await fetch(`${API}/teams`)).json()).sports[0].leagues[0].teams.map(t => t.team);
  const rosters = await Promise.all(teams.map(async t => {
    const r = await (await fetch(`${API}/teams/${t.id}/roster`)).json();
    return { abbr: t.abbreviation, players: (r.athletes ?? []).flatMap(g => g.items ?? []).map(a => ({ name: a.fullName, headshot: a.headshot?.href, practiceSquad: a.status?.name === 'Practice Squad' })) };
  }));
  const inj = await (await fetch(`${API}/injuries`)).json();
  const injuries = (inj.injuries ?? []).flatMap(t => (t.injuries ?? []).map(i => ({
    name: i.athlete?.displayName, team: i.athlete?.team?.abbreviation, status: i.status,
    part: i.details?.type, detail: i.details?.detail, returnDate: i.details?.returnDate, note: i.shortComment,
  })));
  cached = { fetched: Date.now(), rosters, injuries };
  return cached;
}

// weeks out from an estimated return date; a return after the regular season (mid-January) is season-ending
function weeksOut(inj, today) {
  if (!inj.returnDate) return inj.status === 'Injured Reserve' ? 4 : 1;
  const back = new Date(inj.returnDate + 'T12:00:00');
  const seasonEnd = new Date(today.getMonth() >= 6 ? today.getFullYear() + 1 : today.getFullYear(), 0, 15);
  if (back > seasonEnd) return 24;
  const days = Math.round((back - today) / 864e5);
  return Math.max(1, Math.min(24, Math.ceil(days / 7)));
}

function syncRoster(basePath, outPath, nfl, { releaseMissing = false, today = new Date() } = {}) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists`);
  const src = readRosterFile(basePath);
  const d = src.data;
  const FA = d.TEAM.find(t => t.TSNA === 'FA')?.TGID ?? 1009;
  const abbrOf = id => d.TEAM.find(t => t.TGID === id)?.TSNA ?? String(id);
  const notes = { moved: [], released: [], injured: [], unmatched: 0 };

  // index roster players by name; several players can share a name
  const byName = new Map();
  for (const p of d.PLAY) { const k = normName(`${p.PFNA} ${p.PLNA}`); byName.set(k, [...(byName.get(k) ?? []), p]); }
  const find = (name, teamId) => {
    const hits = byName.get(normName(name)) ?? [];
    if (hits.length <= 1) return hits[0];
    return hits.find(p => tg(p) === teamId) ?? hits.find(p => tg(p) === FA) ?? null;
  };

  const pull = p => {
    for (const r of d.DCHT.filter(r => r.PGID === p.PGID))
      for (const o of d.DCHT) if (tg(o) === tg(r) && pos(o) === pos(r) && dep(o) > dep(r)) set(o, 'DDEP', dep(o) - 1);
    d.DCHT = d.DCHT.filter(r => r.PGID !== p.PGID);
  };
  // join a team's depth chart at his position, ranked by overall
  const place = (p, teamId) => {
    const group = d.DCHT.filter(r => tg(r) === teamId && pos(r) === pos(p)).sort((a, b) => dep(a) - dep(b));
    const P = new Map(d.PLAY.map(x => [x.PGID, x]));
    let at = group.findIndex(r => (P.get(r.PGID)?.POVR ?? 0) < (p.POVR ?? 0)); if (at < 0) at = group.length;
    for (const r of group) if (dep(r) >= at) set(r, 'DDEP', dep(r) + 1);
    const row = {}; if (at) row.DDEP = at; row.PGID = p.PGID; if (pos(p)) row.PPOS = pos(p); row.TGID = teamId; d.DCHT.push(row);
  };
  const blobs = d.BLOB.BLOB[0].BLBM;
  const fixJersey = (p, teamId) => {
    const taken = new Set(d.PLAY.filter(x => tg(x) === teamId && x !== p).map(x => x.PJEN ?? 0));
    const want = p.PJEN ?? 0; if (!taken.has(want)) return;
    const n = [...Array(99).keys()].map(i => i + 1).sort((a, b) => Math.abs(a - want) - Math.abs(b - want)).find(x => !taken.has(x));
    set(p, 'PJEN', n);
    const raw = blobs.get(p.PGID); if (raw) { const doc = readAppearance(raw); doc.CHVI.CJNO = n; blobs.set(p.PGID, writeAppearance(doc)); }
  };

  // team moves: trades, signings. Madden has no practice squad, so practice-squad players don't move.
  const MAX_ROSTER = 75;
  const size = new Map(); for (const p of d.PLAY) size.set(tg(p), (size.get(tg(p)) ?? 0) + 1);
  const seen = new Set();
  for (const team of nfl.rosters) {
    const teamId = TEAM_ID[team.abbr]; if (!teamId) continue;
    for (const a of team.players) {
      const p = find(a.name, teamId);
      if (!p) { notes.unmatched++; continue; }
      seen.add(p.PGID);
      if (tg(p) === teamId || a.practiceSquad) continue;
      if ((size.get(teamId) ?? 0) >= MAX_ROSTER) { notes.moved.push(`skipped ${p.PFNA} ${p.PLNA} -> ${abbrOf(teamId)} (team at ${MAX_ROSTER} players)`); continue; }
      size.set(tg(p), size.get(tg(p)) - 1); size.set(teamId, (size.get(teamId) ?? 0) + 1);
      const from = abbrOf(tg(p));
      pull(p); p.TGID = teamId; place(p, teamId); fixJersey(p, teamId);
      notes.moved.push(`${p.PFNA} ${p.PLNA}: ${from} -> ${abbrOf(teamId)}`);
    }
  }
  if (releaseMissing) for (const p of d.PLAY) {
    if (tg(p) === FA || seen.has(p.PGID) || !Object.values(TEAM_ID).includes(tg(p))) continue;
    notes.released.push(`${p.PFNA} ${p.PLNA} (${abbrOf(tg(p))})`);
    pull(p); p.TGID = FA; // injuries are rebuilt below with each player's current team
  }

  // injuries: replace with the current report
  d.INJY = [];
  for (const inj of nfl.injuries) {
    if (!OUT_STATUSES.has(inj.status)) continue;
    const p = find(inj.name, TEAM_ID[inj.team]); if (!p) continue;
    const weeks = weeksOut(inj, today);
    let type = INJURY_TYPE[String(inj.part ?? '').toLowerCase()] ?? OTHER_INJURY;
    if (type === 58 && weeks >= 20) type = 61; // season-ending knee
    d.INJY.push({ INIR: 1, INJL: weeks >= 20 ? 253 : Math.min(244, weeks * 20 + 4), INJS: weeks >= 20 ? 8 : weeks >= 5 ? 7 : 6,
      INJT: type, INSI: 2, INTW: weeks, PGID: p.PGID, TGID: tg(p) });
    notes.injured.push(`${p.PFNA} ${p.PLNA} (${abbrOf(tg(p))}) ${inj.part ?? ''} ${inj.status}, ${weeks >= 20 ? 'season' : weeks + ' wk'}`);
  }
  d.DCHT.sort((a, b) => tg(a) - tg(b) || pos(a) - pos(b) || dep(a) - dep(b));

  const payload = encodePayload(d);
  if (decodePayload(payload).PLAY.length !== d.PLAY.length) throw new Error('verification failed; nothing was written');
  fs.writeFileSync(outPath, buildRosterFile(src.header, payload, { fileSize: src.fileSize }), { flag: 'wx' });
  readRosterFile(outPath); // confirm it reads back with a valid checksum
  return notes;
}

module.exports = { fetchNfl, syncRoster, normName, TEAM_ID };
