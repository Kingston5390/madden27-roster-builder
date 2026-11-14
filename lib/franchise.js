// Franchise saves (CAREER-*), read and written with the community madden-franchise library (MIT), which knows the
// Madden 27 schema. Edits always go to a copy of the save; the original is never opened for writing.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');

const LIB_VERSION = '4.4.1';
const ZERO_REF = '0'.repeat(32);
const DEV = ['Normal', 'Star', 'Superstar', 'XFactor'];
// several Madden 27 enum names share one value (XFactor = College_Elite = 3), so read raw values, never labels
const DEV_VALUE = { First_: 0, Normal: 0, College_Impact: 1, Star: 1, College_Star: 2, Superstar: 2, College_Elite: 3, XFactor: 3 };
const RANKS = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const COACH_MAX_LEVEL = 49;
const ON_A_TEAM = new Set(['Signed', 'PracticeSquad']);
const ROLES = ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'];
const ARCHETYPE_ALIAS = { First: 'OffensiveGuru' }; // value 0 has two names; show the real one

// from source: the npm dependency. In the exe: an embedded copy unpacked once to %APPDATA%
let lib = null;
function loadLibrary() {
  if (lib) return lib;
  try { lib = require('madden-franchise'); return lib; } catch { /* packaged exe */ }
  const sea = require('node:sea');
  const dir = path.join(process.env.APPDATA || os.homedir(), 'RosterBuilder', `madden-franchise-${LIB_VERSION}`);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    for (const key of JSON.parse(sea.getAsset('madden-franchise/manifest.json', 'utf8'))) {
      const out = path.join(dir, key.slice('madden-franchise/'.length));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(sea.getAsset(key)));
    }
    fs.writeFileSync(path.join(dir, '.complete'), LIB_VERSION);
  }
  lib = createRequire(process.execPath)(path.join(dir, 'dist', 'index.cjs'));
  return lib;
}

async function open(file) {
  const Franchise = loadLibrary().default;
  return Franchise.create(file, { autoParse: true });
}
// the save has several tables per name; the real one is the largest
const table = (f, name) => f.tables.filter(t => t.name === name).sort((a, b) => b.header.recordCapacity - a.header.recordCapacity)[0];
const refOf = (rec, key) => { const fld = rec.getFieldByKey(key); return fld && fld.value !== ZERO_REF ? fld.referenceData : null; };
async function follow(f, ref) {
  if (!ref) return null;
  const t = f.getTableById(ref.tableId);
  if (!t) return null;
  await t.readRecords();
  return t.records[ref.rowNumber] ?? null;
}
const devOf = rec => DEV_VALUE[rec.TraitDevelopment] ?? 0;

// every talent of a coach: { talent record, tier records }
async function coachTalents(f, coach) {
  const staff = await follow(f, refOf(coach, 'StaffTalents'));
  if (!staff) return [];
  const out = [];
  for (const kind of ['GamedayTalents', 'PlaysheetTalents']) {
    const list = await follow(f, refOf(staff, kind));
    if (!list) continue;
    for (const slot of list.fieldsArray.filter(x => x.referenceData && x.value !== ZERO_REF)) {
      const talent = await follow(f, slot.referenceData);
      const tierList = talent && await follow(f, refOf(talent, 'Tiers'));
      if (!talent || !tierList) continue;
      const tiers = [];
      for (const t of tierList.fieldsArray.filter(x => x.referenceData && x.value !== ZERO_REF)) { const r = await follow(f, t.referenceData); if (r) tiers.push(r); }
      out.push({ kind: kind === 'GamedayTalents' ? 'Gameday' : 'Playsheet', talent, tiers });
    }
  }
  return out;
}

async function summarizeFranchise(file) {
  const f = await open(file);
  const teams = table(f, 'Team'); await teams.readRecords(['TeamIndex', 'DisplayName', 'LongName', 'ShortName', ...ROLES]);
  const teamRecs = teams.records.filter(r => !r.isEmpty && r.TeamIndex >= 0 && r.TeamIndex < 32).sort((a, b) => a.TeamIndex - b.TeamIndex);
  const team = teamRecs.map(r => ({ index: r.TeamIndex, abbr: r.ShortName, city: r.LongName, name: r.DisplayName }));

  // a team's staff is whoever its HeadCoach/coordinator fields point at (Coach.TeamIndex also matches fired and legend coaches)
  const coaches = table(f, 'Coach'); await coaches.readRecords();
  const staff = [];
  for (const t of teamRecs) for (const role of ROLES) {
    const ref = refOf(t, role);
    const c = ref && ref.tableId === coaches.header.tableId ? coaches.records[ref.rowNumber] : null;
    if (!c || c.isEmpty) continue;
    const talents = await coachTalents(f, c);
    staff.push({ row: ref.rowNumber, first: c.FirstName, last: c.LastName, role, team: t.TeamIndex, user: !!c.IsUserControlled, level: c.Level, maxLevel: !!c.IsMaxLevel,
      archetype: ARCHETYPE_ALIAS[c.Archetype] ?? String(c.Archetype).replace(/_.*/, ''), talents: talents.length,
      tiersOwned: talents.reduce((n, x) => n + x.tiers.filter(tier => tier.TierStatus === 'Owned' || tier.TierStatus === 'Mastered').length, 0),
      tiersTotal: talents.reduce((n, x) => n + x.tiers.length, 0) });
  }

  const players = table(f, 'Player');
  await players.readRecords(['FirstName', 'LastName', 'TeamIndex', 'Position', 'ContractStatus', 'OverallRating', 'TraitDevelopment', 'Age', 'JerseyNum', 'Contract']);
  const playerTableId = players.header.tableId;
  let contracts = null; // PlayerContract table, read once
  const abilities = new Map();
  const asd = table(f, 'ActiveSignatureData'); await asd.readRecords();
  for (const [row, a] of asd.records.entries()) {
    const ref = a.isEmpty ? null : refOf(a, 'Player');
    if (!ref || ref.tableId !== playerTableId) continue;
    (abilities.get(ref.rowNumber) ?? abilities.set(ref.rowNumber, []).get(ref.rowNumber)).push({ row, rank: a.Rank, slot: a.SlotIndex, active: !!a.Active });
  }
  const roster = [];
  for (const [row, p] of players.records.entries()) {
    if (p.isEmpty || !p.FirstName || !ON_A_TEAM.has(p.ContractStatus) || !(p.TeamIndex >= 0 && p.TeamIndex < 32)) continue;
    const ref = refOf(p, 'Contract');
    if (ref && !contracts) { contracts = f.getTableById(ref.tableId); await contracts.readRecords(); }
    const c = ref && ref.tableId === contracts?.header.tableId ? contracts.records[ref.rowNumber] : null;
    const cur = c?.CurrentYear ?? 0;
    roster.push({ row, first: p.FirstName, last: p.LastName, team: p.TeamIndex, position: p.Position, ovr: p.OverallRating, age: p.Age, jersey: p.JerseyNum,
      ps: p.ContractStatus === 'PracticeSquad', dev: devOf(p), abilities: (abilities.get(row) ?? []).sort((a, b) => a.slot - b.slot),
      // years left and this year's salary, in Madden's units of $10K
      contract: c && !c.isEmpty && c.Length > cur ? { years: c.Length - cur, salary: c[`SalaryYear${cur}`] ?? 0, bonus: c[`BonusYear${cur}`] ?? 0 } : null });
  }
  return { teams: team, coaches: staff, players: roster, schema: f.schema?.meta ?? null };
}

// a new deal from this season on: `years` left at `salary` a year ($10K units). Bonuses past the new end are dropped, and the
// player's cap number follows this year's salary plus bonus.
const CONTRACT_MAX_YEARS = 7; // bonuses are stored for 7 contract years
async function setContract(f, p, years, salary) {
  const c = await follow(f, refOf(p, 'Contract'));
  if (!c || c.isEmpty) return false;
  const cur = c.CurrentYear ?? 0;
  years = Math.max(1, Math.min(CONTRACT_MAX_YEARS - cur, Math.round(Number(years))));
  salary = Math.max(30, Math.min(10000, Math.round(Number(salary))));
  c.Length = cur + years;
  for (let y = cur; y < 10; y++) c[`SalaryYear${y}`] = y < cur + years ? salary : 0;
  for (let y = cur + years; y < CONTRACT_MAX_YEARS; y++) c[`BonusYear${y}`] = 0;
  p.PLYR_CAPSALARY = salary + (c[`BonusYear${cur}`] ?? 0);
  return { years, salary };
}

// edits: { players: {row: {dev, contract: {years, salary}}}, coaches: {row: {level, maxTalents}}, abilities: {row: {rank}} }
async function applyFranchiseEdits(basePath, outPath, edits) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new name`);
  fs.copyFileSync(basePath, outPath, fs.constants.COPYFILE_EXCL);
  const notes = [];
  try {
    const f = await open(outPath);
    const players = table(f, 'Player'); await players.readRecords();
    for (const [row, e] of Object.entries(edits.players ?? {})) {
      const p = players.records[Number(row)];
      if (!p || p.isEmpty) continue;
      if (e.dev >= 0 && e.dev <= 3) { p.TraitDevelopment = DEV[e.dev]; notes.push(`${p.FirstName} ${p.LastName}: dev trait ${DEV[e.dev]}`); }
      if (e.contract) {
        const k = await setContract(f, p, e.contract.years, e.contract.salary);
        if (k) notes.push(`${p.FirstName} ${p.LastName}: ${k.years} year${k.years === 1 ? '' : 's'} at $${(k.salary / 100).toFixed(2)}M a year`);
      }
    }
    const coaches = table(f, 'Coach'); await coaches.readRecords();
    for (const [row, e] of Object.entries(edits.coaches ?? {})) {
      const c = coaches.records[Number(row)];
      if (!c || c.isEmpty) continue;
      if (e.level !== undefined) {
        const level = Math.max(0, Math.min(COACH_MAX_LEVEL, Math.round(Number(e.level))));
        c.Level = level; c.IsMaxLevel = level === COACH_MAX_LEVEL;
        notes.push(`${c.FirstName} ${c.LastName}: level ${level}`);
      }
      if (e.maxTalents) {
        const talents = await coachTalents(f, c);
        for (const t of talents) { for (const tier of t.tiers) if (tier.TierStatus !== 'Mastered') tier.TierStatus = 'Owned'; t.talent.CurrentTier = t.tiers.length - 1; }
        notes.push(`${c.FirstName} ${c.LastName}: maxed ${talents.length} talents`);
      }
    }
    const asd = table(f, 'ActiveSignatureData'); await asd.readRecords();
    for (const [row, e] of Object.entries(edits.abilities ?? {})) {
      const a = asd.records[Number(row)];
      if (!a || a.isEmpty || !RANKS.includes(e.rank)) continue;
      a.Rank = e.rank;
    }
    const ranked = Object.keys(edits.abilities ?? {}).length;
    if (ranked) notes.push(`${ranked} ability rank${ranked === 1 ? '' : 's'} changed`);
    await f.save();

    // read the written copy back and confirm every edit stuck
    const back = await open(outPath);
    const bp = table(back, 'Player'); await bp.readRecords(['TraitDevelopment']);
    for (const [row, e] of Object.entries(edits.players ?? {})) if (e.dev !== undefined && devOf(bp.records[Number(row)]) !== e.dev) throw new Error(`dev trait did not save for player ${row}`);
    const bc = table(back, 'Coach'); await bc.readRecords(['Level']);
    for (const [row, e] of Object.entries(edits.coaches ?? {})) if (e.level !== undefined && bc.records[Number(row)].Level !== Math.max(0, Math.min(COACH_MAX_LEVEL, Math.round(Number(e.level))))) throw new Error(`level did not save for coach ${row}`);
    return { file: path.basename(outPath), notes };
  } catch (err) {
    fs.rmSync(outPath, { force: true }); // never leave a half-written save behind
    throw err;
  }
}

// Start at a real week: every game already final in real life (results, from lib/season.js) gets Madden's own force-win set
// to the real winner, in a copy of the save. Simming to the week in Madden then plays them with those winners, so records and
// standings match, and Madden does its usual weekly work (injuries, stats, news). Ties can't be forced and are left alone.
async function setRealWinners(basePath, outPath, results, throughWeek) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new name`);
  fs.copyFileSync(basePath, outPath, fs.constants.COPYFILE_EXCL);
  try {
    const f = await open(outPath);
    const info = table(f, 'SeasonInfo'); await info.readRecords();
    const si = info.records.find(r => !r.isEmpty);
    if (!['PreSeason', 'NFLSeason'].includes(si.CurrentStage) || (si.CurrentStage === 'NFLSeason' && si.CurrentWeekType !== 'RegularSeason'))
      throw new Error(`This save is in ${si.CurrentStage} (${si.CurrentWeekType}); use one from the preseason or regular season of ${si.CurrentSeasonYear}`);
    const teams = table(f, 'Team'); await teams.readRecords(['TeamIndex', 'ShortName']);
    const games = table(f, 'SeasonGame'); await games.readRecords();
    const idx = (g, side) => { const ref = refOf(g, side); return ref && ref.tableId === teams.header.tableId ? teams.records[ref.rowNumber]?.TeamIndex : null; };
    const regular = games.records.filter(g => !g.isEmpty && g.SeasonWeekType === 'RegularSeason').map(g => ({ g, week: g.SeasonWeek + 1, home: idx(g, 'HomeTeam'), away: idx(g, 'AwayTeam') }));
    const used = new Set(), out = { forced: 0, played: 0, ties: [], missing: [] };
    for (const r of results.filter(x => x.week <= throughWeek)) {
      // the same week first; a game Madden has in a different week (a flexed or moved game) second
      const m = regular.find(x => !used.has(x) && x.week === r.week && x.home === r.home && x.away === r.away)
        ?? regular.find(x => !used.has(x) && x.home === r.home && x.away === r.away);
      if (!m) { out.missing.push(r.label); continue; }
      used.add(m);
      if (m.g.GameStatus !== 'Unplayed') { out.played++; continue; }
      if (r.homeScore === r.awayScore) { out.ties.push(r.label); continue; }
      m.g.ForceWin = r.homeScore > r.awayScore ? 'Home' : 'Away';
      out.forced++;
    }
    await f.save();
    // read it back: every forced game must say so
    const back = await open(outPath), bg = table(back, 'SeasonGame'); await bg.readRecords(['ForceWin']);
    const set = bg.records.filter(g => !g.isEmpty && g.ForceWin && g.ForceWin !== 'None').length;
    if (set < out.forced) throw new Error(`only ${set} of ${out.forced} results saved`);
    return { file: path.basename(outPath), season: si.CurrentSeasonYear, ...out };
  } catch (err) {
    fs.rmSync(outPath, { force: true });
    throw err;
  }
}

// Open at a real week (experimental): writes every real result before `week` into the schedule as played games, rebuilds
// every team's record, splits, points and standings from them, and moves the season to that week. Madden's own weekly work
// for the skipped weeks (box scores, player stats, injuries, news) doesn't happen. The save must be in the regular season.
const { DIVISION } = require('./season');
function quarters(total) { // a plausible split of a final score into quarters, in touchdowns and field goals
  const q = [0, 0, 0, 0]; let left = total, i = 0;
  while (left >= 3) { const pts = left >= 7 && (left % 3 !== 0 || i % 2) ? 7 : 3; q[(i * 3 + total) % 4] += pts; left -= pts; i++; }
  q[3] += left;
  return q;
}
async function jumpToRealWeek(basePath, outPath, results, week) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new name`);
  fs.copyFileSync(basePath, outPath, fs.constants.COPYFILE_EXCL);
  try {
    const f = await open(outPath);
    const info = table(f, 'SeasonInfo'); await info.readRecords();
    const si = info.records.find(r => !r.isEmpty);
    if (si.CurrentStage !== 'NFLSeason' || si.CurrentWeekType !== 'RegularSeason')
      throw new Error(`Opening at a week needs a save in the regular season; this one is in ${si.CurrentStage} (${si.CurrentWeekType}). Start the season in Madden (week 1), save, and use that.`);
    if (si.CurrentWeek > week - 1) throw new Error(`This save is already at week ${si.CurrentWeek + 1}`);
    const teams = table(f, 'Team'); await teams.readRecords();
    const games = table(f, 'SeasonGame'); await games.readRecords();
    const team = (g, side) => { const ref = refOf(g, side); return ref && ref.tableId === teams.header.tableId ? teams.records[ref.rowNumber] : null; };
    const regular = games.records.filter(g => !g.isEmpty && g.SeasonWeekType === 'RegularSeason')
      .map(g => ({ g, week: g.SeasonWeek + 1, home: team(g, 'HomeTeam')?.TeamIndex, away: team(g, 'AwayTeam')?.TeamIndex }));
    // 1. the real results, as played games
    const used = new Set(), missing = [];
    let written = 0;
    for (const r of results.filter(x => x.week < week)) {
      const m = regular.find(x => !used.has(x) && x.week === r.week && x.home === r.home && x.away === r.away)
        ?? regular.find(x => !used.has(x) && x.home === r.home && x.away === r.away);
      if (!m) { missing.push(r.label); continue; }
      used.add(m);
      const g = m.g, hq = quarters(r.homeScore), aq = quarters(r.awayScore);
      g.HomeScore = r.homeScore; g.AwayScore = r.awayScore; g.HomeScoreOT = 0; g.AwayScoreOT = 0;
      hq.forEach((v, i) => { g[`HomeScoreQuarter${i + 1}`] = v; }); aq.forEach((v, i) => { g[`AwayScoreQuarter${i + 1}`] = v; });
      g.GameStatus = r.homeScore > r.awayScore ? 'HomeWon' : r.awayScore > r.homeScore ? 'AwayWon' : 'Tied';
      g.IsSimmed = true; g.ForceWin = 'None';
      m.result = { home: r.homeScore, away: r.awayScore };
      written++;
    }
    // games before the week that weren't in the real results keep whatever the save has (normally none)
    const finished = regular.filter(x => x.week < week && x.g.GameStatus !== 'Unplayed' && x.home != null && x.away != null)
      .map(x => ({ ...x, hs: x.result?.home ?? x.g.HomeScore, as: x.result?.away ?? x.g.AwayScore })).sort((a, b) => a.week - b.week);
    // 2. every team's record, splits and points, rebuilt from those games
    const rec = new Map(teams.records.filter(t => !t.isEmpty && t.TeamIndex >= 0 && t.TeamIndex < 32).map(t => [t.TeamIndex, { t, w: 0, l: 0, tie: 0, pf: 0, pa: 0, streak: 0, f: {} }]));
    const add = (o, k) => { o.f[k] = (o.f[k] ?? 0) + 1; };
    for (const x of finished) {
      for (const side of ['home', 'away']) {
        const me = rec.get(side === 'home' ? x.home : x.away), them = side === 'home' ? x.away : x.home; if (!me) continue;
        const pf = side === 'home' ? x.hs : x.as, pa = side === 'home' ? x.as : x.hs, res = pf > pa ? 'Win' : pf < pa ? 'Loss' : 'Tie';
        const sameConf = DIVISION[me.t.TeamIndex][0] === DIVISION[them][0], sameDiv = sameConf && DIVISION[me.t.TeamIndex][1] === DIVISION[them][1];
        me.pf += pf; me.pa += pa; me[res === 'Win' ? 'w' : res === 'Loss' ? 'l' : 'tie']++;
        add(me, (side === 'home' ? 'Home' : 'Road') + res); add(me, 'OutDoor' + res);
        add(me, (sameConf ? 'Conf' : 'NonConf') + res);
        if (sameDiv) add(me, 'Division' + res);
        if (sameConf) { me.f.SeasonConfPointsFor = (me.f.SeasonConfPointsFor ?? 0) + pf; me.f.SeasonConfPointsAgainst = (me.f.SeasonConfPointsAgainst ?? 0) + pa; }
        if (sameDiv) { me.f.SeasonDivPointsFor = (me.f.SeasonDivPointsFor ?? 0) + pf; me.f.SeasonDivPointsAgainst = (me.f.SeasonDivPointsAgainst ?? 0) + pa; }
        me.streak = res === 'Win' ? Math.max(0, me.streak) + 1 : res === 'Loss' ? Math.min(0, me.streak) - 1 : 0;
      }
    }
    const pct = o => o.w + o.l + o.tie ? (o.w + o.tie / 2) / (o.w + o.l + o.tie) : 0;
    const better = (a, b) => pct(b) - pct(a) || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf;
    for (const o of rec.values()) {
      const t = o.t;
      for (const k of ['Home', 'Road', 'Conf', 'NonConf', 'Division', 'InDoor', 'OutDoor', 'OverTime']) for (const r of ['Win', 'Loss', 'Tie']) t[k + r] = o.f[k + r] ?? 0;
      t.SeasonLeagPointsFor = o.pf; t.SeasonLeagPointsAgainst = o.pa;
      for (const k of ['SeasonConfPointsFor', 'SeasonConfPointsAgainst', 'SeasonDivPointsFor', 'SeasonDivPointsAgainst']) t[k] = o.f[k] ?? 0;
      t.SeasonWinPct = Math.round(pct(o) * 1000); t.SeasonWinLossStreak = o.streak;
    }
    // 3. standings: division order, conference order (division leaders first, like playoff seeding), league order
    const all = [...rec.values()];
    all.sort(better).forEach((o, i) => { o.t.CurSeasonLeagStanding = i; });
    for (const conf of ['AFC', 'NFC']) {
      const leaders = [], rest = [];
      for (const div of ['East', 'North', 'South', 'West']) {
        const d = all.filter(o => DIVISION[o.t.TeamIndex][0] === conf && DIVISION[o.t.TeamIndex][1] === div).sort(better);
        d.forEach((o, i) => { o.t.CurSeasonDivStanding = i; });
        leaders.push(d[0]); rest.push(...d.slice(1));
      }
      [...leaders.sort(better), ...rest.sort(better)].forEach((o, i) => { o.t.CurSeasonConfStanding = i; });
    }
    // 4. the season moves to the week
    si.CurrentWeek = week - 1;
    await f.save();
    const back = await open(outPath), bi = table(back, 'SeasonInfo'); await bi.readRecords(['CurrentWeek']);
    if (bi.records.find(r => !r.isEmpty).CurrentWeek !== week - 1) throw new Error('the week did not save');
    const standings = all.sort(better).map(o => `${o.t.ShortName} ${o.w}-${o.l}${o.tie ? '-' + o.tie : ''}`);
    return { file: path.basename(outPath), season: si.CurrentSeasonYear, week, written, missing, standings };
  } catch (err) {
    fs.rmSync(outPath, { force: true });
    throw err;
  }
}

module.exports = { summarizeFranchise, applyFranchiseEdits, setRealWinners, jumpToRealWeek, DEV, RANKS, COACH_MAX_LEVEL, LIB_VERSION };
