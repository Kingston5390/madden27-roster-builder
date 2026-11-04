// League-wide chaos: shuffle every NFL player to a random team, or give everyone a random position.
'use strict';
const fs = require('node:fs');
const { readRosterFile, buildRosterFile, encodePayload, decodePayload, readAppearance, writeAppearance } = require('./tdb2');

const LAST_POS = 20;
const tg = r => r.TGID ?? 0;
const pos = r => r.PPOS ?? 0;
const set = (r, k, v) => { if (v === 0) delete r[k]; else r[k] = v; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// rebuild every team's position depth charts (slots 0-20) by overall; special-teams slots keep players still on that team
function rebuildDepth(d, teamIds) {
  const team = new Map(d.PLAY.map(p => [p.PGID, tg(p)]));
  d.DCHT = d.DCHT.filter(r => !teamIds.has(tg(r)) || (pos(r) > LAST_POS && team.get(r.PGID) === tg(r)));
  for (const t of teamIds) {
    const squad = d.PLAY.filter(p => tg(p) === t);
    for (let s = 0; s <= LAST_POS; s++)
      squad.filter(p => pos(p) === s).sort((a, b) => (b.POVR ?? 0) - (a.POVR ?? 0)).forEach((p, i) => {
        const r = {}; if (i) r.DDEP = i; r.PGID = p.PGID; if (s) r.PPOS = s; r.TGID = t; d.DCHT.push(r);
      });
  }
  d.DCHT.sort((a, b) => tg(a) - tg(b) || pos(a) - pos(b) || (a.DDEP ?? 0) - (b.DDEP ?? 0));
  // close the holes left in kept special-teams slots by players who changed teams
  let key = null, n = 0;
  for (const r of d.DCHT) { const k = `${tg(r)}/${pos(r)}`; n = k === key ? n + 1 : 0; key = k; set(r, 'DDEP', n); }
}

function fixJerseys(d, teamIds) {
  const blobs = d.BLOB.BLOB[0].BLBM;
  for (const t of teamIds) {
    const taken = new Set();
    for (const p of d.PLAY.filter(p => tg(p) === t)) {
      let n = p.PJEN ?? 0;
      if (taken.has(n)) {
        n = [...Array(99).keys()].map(i => i + 1).sort((a, b) => Math.abs(a - n) - Math.abs(b - n)).find(x => !taken.has(x)) ?? n;
        set(p, 'PJEN', n);
        const raw = blobs.get(p.PGID); if (raw) { const doc = readAppearance(raw); doc.CHVI.CJNO = n; blobs.set(p.PGID, writeAppearance(doc)); }
      }
      taken.add(n);
    }
  }
}

// op: 'shuffleTeams' | 'shufflePositions'
function leagueChaos(basePath, outPath, op) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new name`);
  const src = readRosterFile(basePath);
  const d = src.data;
  const FA = d.TEAM.find(t => t.TSNA === 'FA')?.TGID ?? 1009;
  const teamIds = new Set(d.TEAM.map(t => t.TGID).filter(id => id !== FA));
  const nfl = d.PLAY.filter(p => teamIds.has(tg(p)));

  if (op === 'shuffleTeams') {
    // deal everyone out again, keeping each team's roster size
    const seats = shuffle(nfl.map(p => tg(p)));
    nfl.forEach((p, i) => { p.TGID = seats[i]; });
    for (const i of d.INJY) { const p = nfl.find(x => x.PGID === i.PGID); if (p) i.TGID = p.TGID; }
    fixJerseys(d, teamIds);
  } else if (op === 'shufflePositions') {
    for (const p of nfl) set(p, 'PPOS', Math.floor(Math.random() * (LAST_POS + 1)));
  } else throw new Error(`unknown league action ${op}`);

  rebuildDepth(d, teamIds);
  const payload = encodePayload(d);
  if (decodePayload(payload).PLAY.length !== d.PLAY.length) throw new Error('verification failed; nothing was written');
  fs.writeFileSync(outPath, buildRosterFile(src.header, payload, { fileSize: src.fileSize }), { flag: 'wx' });
  readRosterFile(outPath);
  return { players: nfl.length, teams: teamIds.size };
}

module.exports = { leagueChaos, rebuildDepth };
