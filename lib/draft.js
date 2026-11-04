// Madden 27 draft class files (CAREERDRAFT-*): a 70-byte header, then fixed 5876-byte prospect slots.
// Field order follows the Madden 25/26 layout documented by the community, with Madden 27's larger sizes.
// EA's classes reserve more slots than they use (455 for 389 prospects); created prospects go in the empty ones.
'use strict';
const fs = require('node:fs');

const HEADER = 0x46;       // records start here
const DATA_SIZE_AT = 0x0e; // bytes reserved for prospect slots (UInt32 LE)
const COUNT_AT = 0x42;     // number of prospects (UInt32 LE)
const SLOT = 5876;
const VISUALS = 5632;      // JSON appearance block (generic head, skin tone, gear), zero-padded
const FLAG_AT = 5778;      // unidentified per-prospect flag; 0 for nearly every prospect, so created ones get 0

// tail fields: [name, offset in slot, kind, size]
const FIELDS = [
  ['firstName', 5632, 'str', 21], ['lastName', 5653, 'str', 21], ['homeState', 5674, 'u8'], ['homeTown', 5675, 'str', 27],
  ['college', 5702, 'u16'], ['birthDate', 5704, 'u16'], ['age', 5706, 'u8'], ['height', 5707, 'u8'], ['weight', 5708, 'u16'],
  ['position', 5710, 'u8'], ['archetype', 5711, 'u8'], ['jersey', 5712, 'u8'], ['draftable', 5713, 'u8'], ['draftPick', 5714, 'u16'],
  ['draftRound', 5716, 'u8'], ['overall', 5717, 'u8'], ['devTrait', 5776, 'u8'], ['bodyType', 5777, 'u8'],
  ['portraitId', 5780, 'u16'], ['qbStyle', 5782, 'u8'], ['qbStance', 5783, 'u8'], ['commentaryId', 5790, 'u16'], ['assetName', 5792, 'str', 84],
];
// one byte each, 0-99
const RATINGS_A = ['acceleration', 'agility', 'awareness', 'ballCarrierVision', 'blockShedding', 'breakSack', 'breakTackle', 'carrying', 'catching',
  'catchInTraffic', 'changeOfDirection', 'finesseMoves', 'hitPower', 'impactBlocking', 'injury', 'jukeMove', 'jumping', 'kickAccuracy', 'kickPower',
  'kickReturn', 'leadBlock'];
const RATINGS_B = ['manCoverage', 'passBlockFinesse', 'passBlockPower', 'passBlock', 'personality', 'playAction', 'playRecognition', 'powerMoves',
  'pressCoverage', 'pursuit', 'release', 'shortRouteRunning', 'mediumRouteRunning', 'deepRouteRunning', 'runBlockFinesse', 'runBlockPower', 'runBlock',
  'runningStyle', 'spectacularCatch', 'speed', 'spinMove', 'stamina', 'stiffArm', 'strength', 'tackle', 'throwAccuracyDeep', 'throwAccuracyMid',
  'throwAccuracy', 'throwAccuracyShort', 'throwOnTheRun', 'throwPower', 'throwUnderPressure', 'toughness', 'trucking', 'zoneCoverage', 'morale'];
const RATING_AT = Object.fromEntries([...RATINGS_A.map((n, i) => [n, 5718 + i]), ...RATINGS_B.map((n, i) => [n, 5740 + i])]);
// not user ratings: running style is an animation set, morale is fixed at 50
const NOT_RATINGS = new Set(['runningStyle', 'morale']);
const RATINGS = Object.keys(RATING_AT).filter(n => !NOT_RATINGS.has(n));

const FIELD = Object.fromEntries(FIELDS.map(f => [f[0], f]));
const slotAt = (buf, i) => HEADER + i * SLOT;
const capacityOf = buf => Math.min(Math.floor((buf.length - HEADER) / SLOT), Math.floor(buf.readUInt32LE(DATA_SIZE_AT) / SLOT));

function readField(buf, base, [, off, kind, size]) {
  if (kind === 'u8') return buf[base + off];
  if (kind === 'u16') return buf.readUInt16LE(base + off);
  return buf.toString('latin1', base + off, base + off + size).replace(/\0.*$/s, '');
}
function writeField(buf, base, [, off, kind, size], v) {
  if (kind === 'u8') buf[base + off] = Math.max(0, Math.min(255, Math.round(Number(v))));
  else if (kind === 'u16') buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(Number(v)))), base + off);
  else { buf.fill(0, base + off, base + off + size); buf.write(String(v).slice(0, size - 1), base + off, 'latin1'); }
}

function checkFile(buf) {
  if (buf.toString('latin1', 0, 8) !== 'FBCHUNKS') throw new Error('not a draft class file');
  const count = buf.readUInt32LE(COUNT_AT);
  if (!count || HEADER + count * SLOT > buf.length) throw new Error('unexpected draft class layout (not a Madden 27 draft class?)');
  // every slot has its appearance JSON and a name where we expect them
  for (const i of [0, count - 1]) if (buf[slotAt(buf, i)] !== 0x7b) throw new Error('unexpected draft class layout (not a Madden 27 draft class?)');
  return count;
}

// { prospects, capacity }: capacity is how many prospects the file has room for
function readDraftClass(path) {
  const buf = fs.readFileSync(path);
  const count = checkFile(buf);
  const prospects = [];
  for (let i = 0; i < count; i++) {
    const base = slotAt(buf, i);
    const p = { index: i };
    for (const f of FIELDS) p[f[0]] = readField(buf, base, f);
    p.weight += 160;
    p.ratings = Object.fromEntries(RATINGS.map(n => [n, buf[base + RATING_AT[n]]]));
    prospects.push(p);
  }
  return { prospects, capacity: capacityOf(buf) };
}

// archetype and the QB animation fields follow position: the app copies them from a prospect who plays the new position
const EDITABLE = { firstName: 1, lastName: 1, homeTown: 1, college: 1, age: 1, height: 1, weight: 1, position: 1, archetype: 1, jersey: 1, draftPick: 1,
  draftRound: 1, overall: 1, devTrait: 1, qbStyle: 1, qbStance: 1 };
const LIMITS = { college: [0, 1023], age: [18, 40], height: [60, 127], weight: [160, 415], position: [0, 20], jersey: [0, 99], draftPick: [1, 300],
  draftRound: [1, 63], overall: [0, 99], devTrait: [0, 3] };

function applyEdits(buf, base, e) {
  for (const [name, v] of Object.entries(e)) {
    if (name === 'ratings') { for (const [r, x] of Object.entries(v)) if (RATING_AT[r] && !NOT_RATINGS.has(r)) buf[base + RATING_AT[r]] = Math.max(0, Math.min(99, Math.round(Number(x)))); continue; }
    if (!EDITABLE[name]) continue;
    let val = v;
    if (LIMITS[name]) val = Math.max(LIMITS[name][0], Math.min(LIMITS[name][1], Math.round(Number(v))));
    if (name === 'weight') val -= 160;
    writeField(buf, base, FIELD[name], val);
  }
}

// edits: { index: { field: value, ratings: { name: value } } } for prospects already in the class.
// added: created prospects, each { template: index of a prospect whose look (face, gear, archetype) it copies, ...fields, ratings }.
// Always writes a new file.
function writeDraftClass(basePath, outPath, edits, added = []) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new name`);
  const orig = fs.readFileSync(basePath), buf = Buffer.from(orig);
  const count = checkFile(buf), capacity = capacityOf(buf);
  if (count + added.length > capacity) throw new Error(`This draft class has room for ${capacity - count} more prospects, not ${added.length}`);
  let changed = 0;
  for (const [k, e] of Object.entries(edits ?? {})) {
    const i = Number(k); if (!(i >= 0 && i < count)) continue;
    applyEdits(buf, slotAt(buf, i), e);
    changed++;
  }
  added.forEach((a, n) => {
    const t = Number(a.template);
    if (!(t >= 0 && t < count)) throw new Error(`Created prospect ${a.firstName ?? ''} ${a.lastName ?? ''} has no prospect to copy a look from`);
    const base = slotAt(buf, count + n);
    orig.copy(buf, base, slotAt(orig, t), slotAt(orig, t) + SLOT); // the template as the file has it, before any edits
    writeField(buf, base, FIELD.assetName, '');   // the generic head in the copied look, not the template's scanned face
    writeField(buf, base, FIELD.commentaryId, 0); // no announcer name: Madden has no audio for a made-up one
    buf[base + FLAG_AT] = 0;
    applyEdits(buf, base, a);
  });
  buf.writeUInt32LE(count + added.length, COUNT_AT);
  fs.writeFileSync(outPath, buf, { flag: 'wx' });
  readDraftClass(outPath); // confirm it reads back
  return { prospects: count + added.length, changed, created: added.length };
}

module.exports = { readDraftClass, writeDraftClass, RATINGS };
