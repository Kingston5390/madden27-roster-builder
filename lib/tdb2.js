// Reader/writer for Madden NFL 27 roster files: FBCHUNKS container + EA TDB2 "compressed tag" payload.
// CommonJS port of madden27-roster/tdb2.mjs so it can ship inside a Node single-executable app.
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');

const TYPE = Symbol('tdb2type'); // element type for lists, [k,v] types for maps

function tagName(b, i) {
  const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
  return [18, 12, 6, 0].map(s => String.fromCharCode(((v >> s) & 63) + 32)).join('');
}

function tagBytes(tag) {
  const c = [...tag.slice(0, 4)].map(ch => (ch.charCodeAt(0) - 32) & 63);
  const v = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// 32-bit float field (type 10); keeps the raw bytes so unedited values re-encode exactly
class F32 {
  constructor(bytes) { this.raw = Buffer.from(bytes); }
  get value() { return this.raw.readFloatLE(0); }
  set value(v) { this.raw.writeFloatLE(v, 0); }
  toJSON() { return this.value; }
}

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  u8() { return this.b[this.p++]; }
  // varint: first byte = continue | sign | 6 bits, then 7-bit groups
  int() {
    let x = this.u8(); const neg = x & 0x40; let v = x & 0x3f; let sh = 6;
    while (x & 0x80) { x = this.u8(); v += (x & 0x7f) * 2 ** sh; sh += 7; }
    return neg ? -v : v;
  }
  value(type) {
    switch (type) {
      case 0: return this.int();
      case 1: { const n = this.int(); const s = this.b.toString('latin1', this.p, this.p + n); this.p += n; return s.replace(/\0$/, ''); }
      case 2: { const n = this.int(); const s = Buffer.from(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
      case 3: return this.struct();
      case 4: { const sub = this.u8(); const n = this.int(); const a = []; for (let i = 0; i < n; i++) a.push(this.value(sub)); a[TYPE] = sub; return a; }
      case 5: { const kt = this.u8(), vt = this.u8(); const n = this.int(); const m = new Map(); for (let i = 0; i < n; i++) m.set(this.value(kt), this.value(vt)); m[TYPE] = [kt, vt]; return m; }
      case 10: { const f = new F32(this.b.subarray(this.p, this.p + 4)); this.p += 4; return f; }
      default: throw new Error(`unsupported TDB2 type ${type} at 0x${(this.p - 1).toString(16)}`);
    }
  }
  struct() {
    const o = {};
    while (this.b[this.p] !== 0) {
      const t = tagName(this.b, this.p); this.p += 3;
      if (t in o) throw new Error(`duplicate tag ${t} at 0x${(this.p - 3).toString(16)}`);
      o[t] = this.value(this.u8());
    }
    this.p++;
    return o;
  }
}

function decodePayload(buf) {
  const r = new Reader(buf); const top = {};
  while (r.p < buf.length) { const t = tagName(buf, r.p); r.p += 3; top[t] = r.value(r.u8()); }
  return top;
}

class Writer {
  constructor() { this.chunks = []; this.cur = Buffer.alloc(1 << 20); this.p = 0; }
  ensure(n) { if (this.p + n > this.cur.length) { this.chunks.push(this.cur.subarray(0, this.p)); this.cur = Buffer.alloc(Math.max(1 << 20, n)); this.p = 0; } }
  u8(x) { this.ensure(1); this.cur[this.p++] = x; }
  bytes(b) { this.ensure(b.length); b.copy ? b.copy(this.cur, this.p) : this.cur.set(b, this.p); this.p += b.length; }
  int(v) {
    if (!Number.isInteger(v)) throw new Error(`not an integer: ${v}`);
    const neg = v < 0 || Object.is(v, -0); let a = Math.abs(v);
    let first = (a & 0x3f) | (neg ? 0x40 : 0); a = Math.floor(a / 64);
    if (a) first |= 0x80; this.u8(first);
    while (a) { let x = a & 0x7f; a = Math.floor(a / 128); if (a) x |= 0x80; this.u8(x); }
  }
  typeOf(v) {
    if (typeof v === 'number') return 0;
    if (typeof v === 'string') return 1;
    if (Buffer.isBuffer(v)) return 2;
    if (Array.isArray(v)) return 4;
    if (v instanceof Map) return 5;
    if (v instanceof F32) return 10;
    if (v && typeof v === 'object') return 3;
    throw new Error(`cannot encode ${v}`);
  }
  value(type, v) {
    switch (type) {
      case 0: return this.int(v);
      case 1: { const s = Buffer.from(v + '\0', 'latin1'); this.int(s.length); return this.bytes(s); }
      case 2: this.int(v.length); return this.bytes(v);
      case 3: return this.struct(v);
      case 4: { const sub = v[TYPE] ?? (v.length ? this.typeOf(v[0]) : 3); this.u8(sub); this.int(v.length); for (const x of v) this.value(sub, x); return; }
      case 5: { const [kt, vt] = v[TYPE]; this.u8(kt); this.u8(vt); this.int(v.size); for (const [k, x] of v) { this.value(kt, k); this.value(vt, x); } return; }
      case 10: return this.bytes(v.raw);
    }
  }
  field(tag, v) { const t = this.typeOf(v); this.bytes(tagBytes(tag)); this.u8(t); this.value(t, v); }
  struct(o) { for (const [k, v] of Object.entries(o)) if (v !== undefined) this.field(k, v); this.u8(0); }
  done() { this.chunks.push(this.cur.subarray(0, this.p)); return Buffer.concat(this.chunks); }
}

function encodePayload(top) {
  const w = new Writer();
  for (const [k, v] of Object.entries(top)) w.field(k, v);
  return w.done();
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; t[i] = c >>> 0; } return t; })();
// CRC-32/BZIP2 of the decompressed payload, stored LE at header offset 26
function crc32bzip2(b) { let c = 0xffffffff; for (const x of b) c = (CRC_TABLE[((c >>> 24) ^ x) & 255] ^ (c << 8)) >>> 0; return (c ^ 0xffffffff) >>> 0; }

const HEADER_SIZE = 0x4a;
const DATA_REGION = 6 * 1024 * 1024;

function readRosterFile(path) {
  const file = fs.readFileSync(path);
  if (file.toString('latin1', 0, 8) !== 'FBCHUNKS') throw new Error('not an FBCHUNKS file');
  const header = Buffer.from(file.subarray(0, HEADER_SIZE));
  const payload = zlib.inflateSync(file.subarray(HEADER_SIZE), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (payload.length !== header.readUInt32LE(18)) throw new Error('payload size mismatch');
  if (crc32bzip2(payload) !== header.readUInt32LE(26)) throw new Error('payload checksum mismatch');
  return { header, payload, data: decodePayload(payload), fileSize: file.length };
}

function buildRosterFile(header, payload, { date = new Date(), fileSize = HEADER_SIZE + DATA_REGION } = {}) {
  const h = Buffer.from(header);
  h.writeUInt32LE(payload.length, 18);
  h.writeUInt32LE(crc32bzip2(payload), 26);
  [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
    .forEach((v, i) => h.writeUInt16LE(v, 34 + i * 2));
  const comp = zlib.deflateSync(payload, { level: 9 });
  if (HEADER_SIZE + comp.length > fileSize) throw new Error(`compressed roster (${comp.length} bytes) exceeds the ${fileSize - HEADER_SIZE}-byte data region`);
  const out = Buffer.alloc(fileSize);
  h.copy(out, 0); comp.copy(out, HEADER_SIZE);
  return out;
}

// Each player's appearance blob is a gzip'd TDB2 doc (CHVI holds name, jersey, height HINC, weight WLBS)
const GZIP_HEADER = Buffer.from('1f8b080000000000020a', 'hex');
function readAppearance(raw) { return decodePayload(zlib.inflateRawSync(raw.subarray(10))); }
function writeAppearance(doc) {
  const inner = encodePayload(doc);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(zlib.crc32(inner), 0);
  trailer.writeUInt32LE(inner.length, 4);
  return Buffer.concat([GZIP_HEADER, zlib.deflateRawSync(inner, { level: 9 }), trailer]);
}

module.exports = { tagName, decodePayload, encodePayload, readRosterFile, buildRosterFile, crc32bzip2, readAppearance, writeAppearance, F32 };
