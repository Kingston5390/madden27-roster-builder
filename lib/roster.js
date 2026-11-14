// Roster model for the builder: summarize a roster for the UI, and export a lineup + edits to a new roster file.
'use strict';
const fs = require('node:fs');
const { readRosterFile, buildRosterFile, encodePayload, decodePayload, readAppearance, writeAppearance } = require('./tdb2');

const POS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LOLB', 'MLB', 'ROLB', 'CB', 'FS', 'SS', 'K', 'P'];
const LAST_POS = POS.length - 1;
// 0-99 rating fields; everything a player can be graded on
const RATINGS = ['POVR', 'PSPD', 'PSTR', 'PAGI', 'PACC', 'PAWR', 'PJMP', 'PSTA', 'PINJ', 'PTGH', 'PCTH', 'PCAR', 'PBCV', 'PBKT',
  'PBSG', 'PBSK', 'PDRR', 'PELU', 'PFMS', 'PIMP', 'PKAC', 'PKPR', 'PKRT', 'PLBK', 'PLCE', 'PLCI', 'PLHT', 'PLIB', 'PLJM', 'PLMC',
  'PLPE', 'PLPM', 'PLPR', 'PLPU', 'PLRL', 'PLSA', 'PLSC', 'PLSM', 'PLTR', 'PLZC', 'PMRR', 'PPBF', 'PPBK', 'PPBS', 'PPLA', 'PRBF',
  'PRBK', 'PRBS', 'PSTM', 'PTAD', 'PTAK', 'PTAM', 'PTAS', 'PTHA', 'PTHP', 'PTOR', 'PTUP', 'SRRN'];
const UI_FIELDS = ['PGID', 'PFNA', 'PLNA', 'TGID', 'PPOS', 'PJEN', 'PAGE', 'PHGT', 'PWGT', 'PROL', 'PYRP', ...RATINGS];

const tg = r => r.TGID ?? 0;
const pos = r => r.PPOS ?? 0;
const dep = r => r.DDEP ?? 0;
// fields equal to 0 are omitted from records
const set = (r, k, v) => { if (v === 0) delete r[k]; else r[k] = v; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

function summarize(path) {
  const { data: d } = readRosterFile(path);
  const teams = d.TEAM.map(t => ({ id: t.TGID, abbr: t.TSNA, city: t.TLNA, name: t.TDNA || t.TMNC, primary: [t.TBCR ?? 0, t.TBCG ?? 0, t.TBCB ?? 0], secondary: [t.TB2R ?? 0, t.TB2G ?? 0, t.TB2B ?? 0] }))
    .sort((a, b) => (a.abbr === 'FA') - (b.abbr === 'FA') || a.city.localeCompare(b.city));
  const injured = new Set(d.INJY.map(i => i.PGID));
  const players = d.PLAY.map(p => {
    const o = {}; for (const k of UI_FIELDS) o[k] = p[k] ?? 0;
    o.PWGT += 160; // UI works in pounds
    if (injured.has(p.PGID)) o.injured = 1;
    return o;
  });
  const depth = d.DCHT.filter(r => pos(r) <= LAST_POS).map(r => [tg(r), pos(r), dep(r), r.PGID]);
  return { teams, players, depth };
}

// Legends come from another roster file; the UI addresses them as LEGEND_OFFSET + their id in that file
const LEGEND_OFFSET = 10000000;
const normName = s => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

// players in a legends roster who aren't in the base roster, keyed for the UI
function summarizeLegends(legendsPath, basePath) {
  const base = new Set(readRosterFile(basePath).data.PLAY.map(p => normName(`${p.PFNA} ${p.PLNA}`)));
  const { data: d } = readRosterFile(legendsPath);
  const injured = new Set();
  return d.PLAY.filter(p => !base.has(normName(`${p.PFNA} ${p.PLNA}`)) && tg(p) !== 1009).map(p => {
    const o = {}; for (const k of UI_FIELDS) o[k] = p[k] ?? 0;
    o.PWGT += 160; o.PGID += LEGEND_OFFSET; o.legendTeam = tg(p); o.TGID = 0; o.legend = 1;
    if (injured.has(p.PGID)) o.injured = 1;
    return o;
  });
}

// Madden 27 headshot ids by name (lastfirst, letters/digits), read from the game's portrait library by tools/portraits.mjs.
// Legends rosters carry old or blank portrait ids (PSXP), so imported legends get the id Madden 27 actually uses.
let portraits;
const NICK = Object.fromEntries([['michael', 'mike'], ['richard', 'dick'], ['robert', 'bob'], ['william', 'bill'], ['james', 'jim'], ['joseph', 'joe'],
  ['thomas', 'tom'], ['anthony', 'tony'], ['edward', 'ed'], ['charles', 'chuck'], ['nicholas', 'nick'], ['christopher', 'chris'], ['daniel', 'dan'],
  ['matthew', 'matt'], ['steven', 'steve'], ['stephen', 'steve'], ['kenneth', 'ken'], ['lawrence', 'larry'], ['frederick', 'fred']].flatMap(([a, b]) => [[a, [b]], [b, [a]]]));
function portraitId(p) {
  if (!portraits) {
    try { const sea = require('node:sea'); if (sea.isSea()) portraits = JSON.parse(sea.getAsset('portraits.json', 'utf8')); } catch {}
    portraits ??= JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'portraits.json'), 'utf8'));
  }
  const clean = v => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const first = String(p.PFNA ?? ''), last = String(p.PLNA ?? '');
  const f0 = [first, first.split(/\s+/).pop()].map(clean); // "Mean Joe" -> also "joe"
  const firsts = [...new Set([...f0, ...f0.flatMap(f => NICK[f] ?? [])])];
  const lasts = [...new Set([last, last.replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, '')].map(clean))]; // "Winslow Sr." -> also "winslow"
  const lf = lasts.flatMap(l => firsts.map(f => l + f)), fl = lasts.flatMap(l => firsts.map(f => f + l));
  // legends first in either order; current players by lastfirst only (firstlast could be someone else, e.g. Mason Taylor / Taylor Mason)
  for (const k of [...lf, ...fl]) if (k in portraits.legend) return portraits.legend[k];
  for (const k of lasts.flatMap(l => f0.map(f => l + f))) if (k in portraits.player) return portraits.player[k]; // no nicknames: Mike and Michael Williams differ
}
// players whose portrait id isn't one Madden 27 has (old legends imports, other tools) get theirs by name; returns how many
function fixPortraits(d) {
  portraitId({});
  const valid = new Set([...Object.values(portraits.legend), ...Object.values(portraits.player)]);
  let n = 0;
  for (const p of d.PLAY) { if (valid.has(p.PSXP ?? 0)) continue; const id = portraitId(p); if (id != null) { p.PSXP = id; n++; } }
  return n;
}

// copy players (record, appearance, face settings, contract) from another roster into this one under new ids
function importPlayers(d, legendsPath, legendIds) {
  const src = readRosterFile(legendsPath).data;
  const byId = new Map(src.PLAY.map(p => [p.PGID, p]));
  const srcBlobs = src.BLOB.BLOB[0].BLBM, blobs = d.BLOB.BLOB[0].BLBM;
  let next = Math.max(...d.PLAY.map(p => p.PGID)) + 1;
  const map = new Map();
  for (const uiId of legendIds) {
    const old = byId.get(uiId - LEGEND_OFFSET); if (!old) continue;
    const id = next++;
    const p = { ...old, PGID: id, POID: id, TGID: d.TEAM.find(t => t.TSNA === 'FA')?.TGID ?? 1009 }; // joins the team below like any signing
    const face = portraitId(old); if (face != null) p.PSXP = face;
    d.PLAY.push(p);
    const raw = srcBlobs.get(old.PGID); if (raw) blobs.set(id, Buffer.from(raw));
    const prsn = src.PRSN.find(r => r.PGID === old.PGID); if (prsn) d.PRSN.push({ ...prsn, PGID: id });
    const deal = src.PLCT.find(r => r.PGID === old.PGID); if (deal) d.PLCT.push({ ...deal, PGID: id });
    map.set(uiId, id);
  }
  return map;
}

// opts: { teamId, slots: {ppos: [pgid|null, ...]}, edits: {pgid: {field: value}}, identity, releaseOthers, heal, legendsFile }
function exportRoster(basePath, outPath, opts) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new name`);
  const src = readRosterFile(basePath);
  const d = src.data;
  // bring in any legends first, then treat them like any other player
  const imported = new Set(), uiOf = new Map(); // legends get new ids here; the UI knows them by their legends-file id
  const legendIds = [...new Set(Object.values(opts.slots ?? {}).flat().filter(id => id >= LEGEND_OFFSET))];
  if (legendIds.length) {
    if (!opts.legendsFile) throw new Error('legends roster not found');
    const map = importPlayers(d, opts.legendsFile, legendIds);
    for (const [ui, id] of map) uiOf.set(id, ui);
    for (const id of map.values()) imported.add(id);
    for (const ids of Object.values(opts.slots)) ids.forEach((id, i) => { if (map.has(id)) ids[i] = map.get(id); });
    for (const [k, e] of Object.entries(opts.edits ?? {})) if (map.has(Number(k))) { opts.edits[map.get(Number(k))] = e; delete opts.edits[k]; }
  }
  const fixedFaces = fixPortraits(d);
  const team = d.TEAM.find(t => t.TGID === opts.teamId);
  if (!team) throw new Error(`unknown team ${opts.teamId}`);
  const FA = d.TEAM.find(t => t.TSNA === 'FA').TGID;
  const P = new Map(d.PLAY.map(p => [p.PGID, p]));
  const blobs = d.BLOB.BLOB[0].BLBM;
  const notes = [];
  if (fixedFaces) notes.push(`fixed headshots for ${fixedFaces} players`);

  // dense lineup per position, in depth order
  const lineup = {};
  for (const [k, ids] of Object.entries(opts.slots ?? {})) {
    const s = Number(k); if (!(s >= 0 && s <= LAST_POS)) continue;
    const seen = new Set();
    lineup[s] = ids.filter(id => id != null && P.has(id) && !seen.has(id) && seen.add(id));
  }
  const inLineup = new Set(Object.values(lineup).flat());
  if (!inLineup.size) throw new Error('lineup is empty');

  // remove a player's depth chart rows, closing the gaps they leave
  const pull = pgid => {
    for (const r of d.DCHT.filter(r => r.PGID === pgid))
      for (const o of d.DCHT) if (tg(o) === tg(r) && pos(o) === pos(r) && dep(o) > dep(r)) set(o, 'DDEP', dep(o) - 1);
    d.DCHT = d.DCHT.filter(r => r.PGID !== pgid);
  };

  // players from other teams join this team
  const incoming = new Set();
  for (const id of inLineup) {
    const p = P.get(id);
    if (tg(p) === opts.teamId) continue;
    incoming.add(id);
    const from = imported.has(id) ? 'Legends' : d.TEAM.find(t => t.TGID === tg(p))?.TSNA ?? '?';
    pull(id);
    p.TGID = opts.teamId;
    for (const i of d.INJY) if (i.PGID === id) i.TGID = opts.teamId;
    notes.push(`${p.PFNA} ${p.PLNA}: ${from} -> ${team.TSNA}`);
  }
  if (opts.releaseOthers) for (const p of d.PLAY) if (tg(p) === opts.teamId && !inLineup.has(p.PGID)) {
    pull(p.PGID); p.TGID = FA;
    for (const i of d.INJY) if (i.PGID === p.PGID) i.TGID = FA;
    notes.push(`released ${p.PFNA} ${p.PLNA}`);
  }

  // a player's listed position is the first slot he fills (offense, then defense, then specialists)
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const primary = new Map();
  for (const s of order) for (const id of lineup[s] ?? []) if (!primary.has(id)) primary.set(id, s);
  for (const [id, s] of primary) set(P.get(id), 'PPOS', s);

  // edits
  const appearance = new Map();
  const edited = new Set();
  for (const [k, e] of Object.entries(opts.edits ?? {})) {
    const p = P.get(Number(k)); if (!p) continue;
    const look = {};
    for (const f of RATINGS) if (e[f] !== undefined) set(p, f, clamp(e[f], 0, 99));
    if (e.PROL !== undefined) set(p, 'PROL', clamp(e.PROL, 0, 3));
    if (e.PAGE !== undefined) set(p, 'PAGE', clamp(e.PAGE, 18, 50));
    if (e.PHGT !== undefined) { const h = clamp(e.PHGT, 60, 127); set(p, 'PHGT', h); look.HINC = h; }
    if (e.PWGT !== undefined) { const lbs = clamp(e.PWGT, 160, 415); set(p, 'PWGT', lbs - 160); look.WLBS = lbs; }
    if (e.PJEN !== undefined) { const n = clamp(e.PJEN, 0, 99); set(p, 'PJEN', n); look.CJNO = n; edited.add(p.PGID); }
    if (e.PFNA) { p.PFNA = String(e.PFNA).slice(0, 15); look.CFNM = p.PFNA; }
    if (e.PLNA) { p.PLNA = String(e.PLNA).slice(0, 19); look.CLNM = p.PLNA; }
    if (Object.keys(look).length) appearance.set(p.PGID, look);
  }

  // incoming players keep their own number when it's free. When a teammate already wears it, opts.jerseys[ui id] decides:
  // 'take' (the newcomer gets it and the teammate moves to the nearest free number), a number (wear that one instead), or
  // 'new' (default: the newcomer gets the nearest free number). Numbers typed in the player editor are never moved.
  const roster = d.PLAY.filter(p => tg(p) === opts.teamId);
  const taken = new Map(), conflicts = [], choices = opts.jerseys ?? {};
  const label = p => `${p.PFNA} ${p.PLNA}`;
  const nearest = want => [...Array(99).keys()].map(i => i + 1).sort((a, b) => Math.abs(a - want) - Math.abs(b - want)).find(x => !taken.has(x));
  const renumber = (p, n) => { set(p, 'PJEN', n); taken.set(n, p); appearance.set(p.PGID, { ...(appearance.get(p.PGID) ?? {}), CJNO: n }); };
  for (const p of roster) if (!incoming.has(p.PGID) || edited.has(p.PGID)) taken.set(p.PJEN ?? 0, p);
  for (const p of roster) {
    if (!incoming.has(p.PGID) || edited.has(p.PGID)) continue;
    const want = p.PJEN ?? 0;
    if (!taken.has(want)) { taken.set(want, p); continue; }
    const holder = taken.get(want), ui = uiOf.get(p.PGID) ?? p.PGID, locked = edited.has(holder.PGID);
    const choice = choices[ui] ?? opts.jerseyDefault ?? 'new';
    conflicts.push({ id: ui, name: label(p), pos: POS[pos(p)] ?? '', want, holder: label(holder), holderPos: POS[pos(holder)] ?? '', locked, alt: nearest(want) });
    if (choice === 'take' && !locked) {
      taken.set(want, p);
      const n = nearest(want); renumber(holder, n);
      notes.push(`${label(p)} wears #${want}; ${label(holder)} moves to #${n}`);
    } else if (Number.isInteger(Number(choice)) && choice !== '' && Number(choice) >= 0 && Number(choice) <= 99 && !taken.has(Number(choice))) {
      renumber(p, Number(choice));
      notes.push(`${label(p)}: #${want} is ${label(holder)}'s, wears #${Number(choice)}`);
    } else {
      const n = nearest(want); renumber(p, n);
      const busy = choice !== 'new' && choice !== 'take' && taken.get(Number(choice)) !== p ? ` (#${choice} is taken too)` : '';
      notes.push(`${label(p)}: #${want} is ${label(holder)}'s, wears #${n}${busy}`);
    }
  }
  if (opts.check) return { conflicts }; // a dry run for the export window: nothing is written

  for (const [id, look] of appearance) {
    const raw = blobs.get(id); if (!raw) continue;
    const doc = readAppearance(raw);
    Object.assign(doc.CHVI, look);
    blobs.set(id, writeAppearance(doc));
  }

  if (opts.heal) { const before = d.INJY.length; d.INJY = d.INJY.filter(i => !inLineup.has(i.PGID)); if (before !== d.INJY.length) notes.push(`healed ${before - d.INJY.length} injured players`); }

  // depth chart: rebuild this team's position slots from the lineup; keep its special slots for players still on it
  const onTeam = new Set(d.PLAY.filter(p => tg(p) === opts.teamId).map(p => p.PGID));
  d.DCHT = d.DCHT.filter(r => tg(r) !== opts.teamId || (pos(r) > LAST_POS && onTeam.has(r.PGID)));
  for (const [s, ids] of Object.entries(lineup)) ids.forEach((id, i) => {
    const r = {}; if (i) r.DDEP = i; r.PGID = id; if (Number(s)) r.PPOS = Number(s); r.TGID = opts.teamId; d.DCHT.push(r);
  });
  d.DCHT.sort((a, b) => tg(a) - tg(b) || pos(a) - pos(b) || dep(a) - dep(b));

  const id = opts.identity ?? {};
  if (id.city) team.TLNA = String(id.city).slice(0, 20);
  if (id.name) { team.TMNC = team.TDNA = String(id.name).slice(0, 20); }
  if (id.abbr) team.TSNA = String(id.abbr).toUpperCase().slice(0, 4);
  if (Array.isArray(id.primary)) [team.TBCR, team.TBCG, team.TBCB] = id.primary.map(v => clamp(v, 0, 255));
  if (Array.isArray(id.secondary)) [team.TB2R, team.TB2G, team.TB2B] = id.secondary.map(v => clamp(v, 0, 255));

  const payload = encodePayload(d);
  const check = decodePayload(payload);
  if (check.PLAY.length !== d.PLAY.length || check.PLAY.filter(p => tg(p) === opts.teamId).length !== onTeam.size) throw new Error('verification failed; nothing was written');
  const file = buildRosterFile(src.header, payload, { fileSize: src.fileSize });
  fs.writeFileSync(outPath, file, { flag: 'wx' });
  // read back what was written
  const back = readRosterFile(outPath);
  return { path: outPath, players: back.data.PLAY.filter(p => tg(p) === opts.teamId).length, notes };
}

module.exports = { portraitId, summarize, summarizeLegends, exportRoster, POS, RATINGS, LEGEND_OFFSET };
