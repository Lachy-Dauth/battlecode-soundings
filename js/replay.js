// Decoder for UNSW Battlecode .replay files.
//
// A replay is gzip( packed Cap'n Proto message ) whose root is `Replay` from
// engine/replay.capnp in https://github.com/unswcpmsoc/battlecode (MIT,
// UNSW CPMSoc). Field offsets below come from that schema's compiled layout.
// Everything runs locally: bytes never leave the browser.

export const EV = {
  ROUND: 0, TURN: 1, COUNTDOWN: 2, TILE: 3, ACTION: 4, ENGINE_LOG: 5, DRAGON_LOG: 6,
  INDICATOR: 7, DRAW: 8, UPDATE: 9, SPLIT: 10, DEATH: 11, SONAR: 12,
};
export const DIRS = ['N', 'E', 'S', 'W'];
export const DEATH_REASONS = ['hitWall', 'hitSelf', 'hitOtherBody', 'hitHeadToHead', 'noValidAction'];
export const SONAR_KINDS = ['unknown', 'empty', 'kelp', 'ally', 'allyHead', 'enemy', 'enemyHead'];

// ---- bytes ------------------------------------------------------------------

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Undo any number of gzip layers (files are stored gzipped; some are gzipped twice). */
export async function inflate(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < 4 && isGzip(b); i++) b = await gunzip(b);
  return b;
}

/** Cap'n Proto packing: each word is a tag byte then its non-zero bytes. */
export function unpack(src) {
  let out = new Uint8Array(Math.max(4096, src.length * 3));
  let o = 0, i = 0;
  const grow = (need) => {
    let size = out.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, o));
    out = next;
  };
  const n = src.length;
  while (i < n) {
    const tag = src[i++];
    if (tag === 0) {
      const words = 1 + src[i++];
      if (o + words * 8 > out.length) grow(o + words * 8);
      o += words * 8; // buffer is zero-filled past o
      continue;
    }
    if (o + 8 > out.length) grow(o + 8);
    for (let b = 0; b < 8; b++) if (tag & (1 << b)) out[o + b] = src[i++];
    o += 8;
    if (tag === 0xff) {
      const len = src[i++] * 8;
      if (o + len > out.length) grow(o + len);
      out.set(src.subarray(i, i + len), o);
      i += len;
      o += len;
    }
  }
  return out.subarray(0, o);
}

// ---- message ----------------------------------------------------------------

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = this.dv.getUint32(0, true) + 1;
    if (count > 1024) throw new Error('not a Cap\'n Proto message');
    let off = 4 + 4 * count;
    if (off % 8) off += 4;
    this.segs = [];
    for (let s = 0; s < count; s++) {
      const words = this.dv.getUint32(4 + 4 * s, true);
      this.segs.push(off);
      off += words * 8;
    }
    if (off > buf.byteLength) throw new Error('truncated replay');
    this.utf8 = new TextDecoder();
  }

  /** Follow the pointer stored at byte `p` of segment `seg`. */
  ptr(seg, p) {
    const dv = this.dv;
    const lo = dv.getUint32(p, true), hi = dv.getUint32(p + 4, true);
    if (lo === 0 && hi === 0) return null;
    const kind = lo & 3;
    if (kind === 2) {
      const landing = this.segs[hi] + (lo >>> 3) * 8;
      if (!((lo >>> 2) & 1)) return this.ptr(hi, landing);
      // Double-far: landing pad = far pointer to the content, then a tag word.
      const lo2 = dv.getUint32(landing, true), hi2 = dv.getUint32(landing + 4, true);
      const tagLo = dv.getUint32(landing + 8, true), tagHi = dv.getUint32(landing + 12, true);
      return this.target(tagLo & 3, tagHi, this.segs[hi2] + (lo2 >>> 3) * 8, hi2);
    }
    return this.target(kind, hi, p + 8 + ((lo | 0) >> 2) * 8, seg);
  }

  target(kind, hi, at, seg) {
    if (kind === 0) return { seg, at, dw: hi & 0xffff, pw: hi >>> 16 };
    if (kind === 1) {
      const size = hi & 7, count = hi >>> 3;
      if (size === 7) {
        const tagLo = this.dv.getUint32(at, true), tagHi = this.dv.getUint32(at + 4, true);
        const dw = tagHi & 0xffff, pw = tagHi >>> 16;
        return { list: true, seg, at: at + 8, size, count: tagLo >>> 2, dw, pw, step: (dw + pw) * 8 };
      }
      return { list: true, seg, at, size, count };
    }
    throw new Error('unsupported pointer');
  }

  // Struct field readers: fields past a (shorter, older) struct's data read as 0.
  u16(s, off) { return s && off + 2 <= s.dw * 8 ? this.dv.getUint16(s.at + off, true) : 0; }
  i32(s, off) { return s && off + 4 <= s.dw * 8 ? this.dv.getInt32(s.at + off, true) : 0; }
  u32(s, off) { return s && off + 4 <= s.dw * 8 ? this.dv.getUint32(s.at + off, true) : 0; }
  u64(s, off) {
    if (!s || off + 8 > s.dw * 8) return 0;
    return this.dv.getUint32(s.at + off, true) + this.dv.getUint32(s.at + off + 4, true) * 4294967296;
  }
  bit(s, bit) {
    const byte = bit >> 3;
    return !!s && byte < s.dw * 8 && ((this.buf[s.at + byte] >> (bit & 7)) & 1) === 1;
  }
  child(s, idx) { return s && idx < s.pw ? this.ptr(s.seg, s.at + s.dw * 8 + idx * 8) : null; }
  elem(list, i) { return { seg: list.seg, at: list.at + i * list.step, dw: list.dw, pw: list.pw }; }
  text(s, idx) {
    const l = this.child(s, idx);
    if (!l || !l.count) return '';
    return this.utf8.decode(this.buf.subarray(l.at, l.at + l.count - 1));
  }
  point(s, idx) {
    const p = this.child(s, idx);
    return p ? [this.i32(p, 0), this.i32(p, 4)] : [0, 0];
  }
  points(s, idx) {
    const l = this.child(s, idx);
    const out = [];
    if (!l) return out;
    for (let i = 0; i < l.count; i++) { const e = this.elem(l, i); out.push([this.i32(e, 0), this.i32(e, 4)]); }
    return out;
  }
}

// ---- replay -------------------------------------------------------------------

/**
 * Decode replay bytes (gzipped or not, packed or not) into
 * { formatVersion, map, botA, botB, events, result }.
 * Events are small objects tagged by `k` (see EV). Pass `{ logs: false }` to
 * skip bot/engine text and debug drawings, which is much faster for batches.
 */
export async function decodeReplay(bytes, { logs = true } = {}) {
  const raw = await inflate(bytes);
  let r;
  try { r = new Reader(unpack(raw)); } catch (packedErr) {
    try { r = new Reader(raw); } catch { throw packedErr; }
  }
  const root = r.ptr(0, r.segs[0]);
  if (!root || root.list) throw new Error('replay has no root');

  const events = [];
  const list = r.child(root, 3);
  const count = list ? list.count : 0;
  for (let i = 0; i < count; i++) {
    const ev = r.elem(list, i);
    const k = r.u16(ev, 0);
    const b = r.child(ev, 0);
    switch (k) {
      case EV.ROUND: events.push({ k, round: r.i32(b, 0) }); break;
      case EV.TURN: events.push({ k, id: r.i32(b, 0) }); break;
      case EV.COUNTDOWN: { const [x, y] = r.point(b, 0); events.push({ k, x, y, cd: r.i32(b, 0) }); break; }
      case EV.TILE: { const [x, y] = r.point(b, 0); events.push({ k, x, y, pearl: r.bit(b, 0) }); break; }
      case EV.ACTION: {
        const a = r.child(b, 0);
        const ins = r.child(b, 1);
        const e = { k, id: r.i32(b, 0), tle: r.bit(b, 32), kind: null, steps: null, split: 0,
          instr: ins ? r.u64(ins, 0) : null, exceeded: ins ? r.bit(ins, 64) : false };
        if (a) {
          const which = r.u16(a, 0);
          if (which === 0) {
            e.kind = 'move';
            const l = r.child(a, 0);
            e.steps = [];
            if (l) for (let s = 0; s < l.count; s++) e.steps.push(r.dv.getUint16(l.at + s * 2, true));
          } else if (which === 1) { e.kind = 'split'; e.split = r.i32(a, 4); } else e.kind = 'suicide';
        }
        events.push(e);
        break;
      }
      case EV.ENGINE_LOG: case EV.DRAGON_LOG: case EV.INDICATOR:
        if (logs || k === EV.ENGINE_LOG) events.push({ k, id: r.i32(b, 0), text: r.text(b, 0) });
        else events.push({ k, id: r.i32(b, 0) });
        break;
      case EV.DRAW:
        if (logs) {
          const d = r.child(b, 0);
          const [fx, fy] = r.point(d, 0), [tx, ty] = r.point(d, 1);
          events.push({ k, id: r.i32(b, 0), shape: r.u16(d, 0), fx, fy, tx, ty,
            rgb: [r.buf[d.at + 2], r.buf[d.at + 3], r.buf[d.at + 4]] });
        } else events.push({ k, id: r.i32(b, 0) });
        break;
      case EV.UPDATE: {
        const [hx, hy] = r.point(b, 0), [tx, ty] = r.point(b, 1);
        events.push({ k, id: r.i32(b, 0), facing: r.u16(b, 4), hx, hy, tx, ty });
        break;
      }
      case EV.SPLIT:
        events.push({ k, parent: r.i32(b, 0), child: r.i32(b, 4), team: r.u16(b, 8), facing: r.u16(b, 10),
          parentBody: r.points(b, 0), childBody: r.points(b, 1) });
        break;
      case EV.DEATH: events.push({ k, id: r.i32(b, 0), reason: r.u16(b, 4) }); break;
      case EV.SONAR: {
        const [ox, oy] = r.point(b, 0), [ex, ey] = r.point(b, 1);
        const hit = r.u16(b, 6) === 1 ? r.i32(b, 12) : null;
        events.push({ k, id: r.i32(b, 0), dir: r.u16(b, 4), ox, oy, ex, ey, hit, kind: r.u16(b, 24),
          value: r.u64(b, 16) || r.u32(b, 8) });
        break;
      }
      default: break; // unknown event from a newer engine: skip
    }
  }

  const res = r.child(root, 4);
  const standing = (idx) => {
    const s = r.child(res, idx);
    return { dragonCount: r.i32(s, 0), longestDragon: r.i32(s, 4), totalLength: r.i32(s, 8) };
  };
  const result = res ? {
    terminated: r.bit(res, 0),
    endReason: r.u16(res, 2) === 0 ? 'teamEliminated' : 'roundLimit',
    winner: r.u16(res, 4) === 1 ? (r.u16(res, 6) === 0 ? 'A' : 'B') : null,
    teamA: standing(0), teamB: standing(1),
  } : null;

  return {
    formatVersion: r.u32(root, 0),
    map: r.text(root, 0),
    botA: r.text(root, 1),
    botB: r.text(root, 2),
    events,
    result,
  };
}
