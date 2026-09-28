// Decodes and analyses one replay per message, off the main thread.
//   in:  { id, name, bytes: ArrayBuffer, detail: boolean }
//   out: { id, ok: true, game } | { id, ok: false, error }
import { decodeReplay } from './replay.js';
import { analyse, CAUSES } from './analyse.js';

const CAUSE_INDEX = Object.fromEntries(CAUSES.map((c, i) => [c, i]));
const clamp16 = (src) => {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] > 65535 ? 65535 : src[i];
  return out;
};

/** Same game saved twice (e.g. .replay and .replay.gz) → same fingerprint. */
function fingerprint(a) {
  let h = 2166136261 >>> 0;
  const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 16777619) >>> 0; h ^= v >>> 16; h = Math.imul(h, 16777619) >>> 0; };
  for (const str of [a.map.key, a.botA, a.botB]) for (let i = 0; i < str.length; i++) mix(str.charCodeAt(i));
  mix(a.rounds); mix(a.deaths.length); mix(a.eats.length);
  const tl = a.timeline;
  for (const k of ['lenA', 'lenB', 'countA', 'countB', 'eatA', 'eatB']) for (const v of tl[k]) mix(v);
  return `${h.toString(36)}-${a.rounds}-${a.deaths.length}`;
}

/** What a batch keeps per game: small scalars plus a few dense map layers. */
function summarise(a) {
  const N = a.map.width * a.map.height;
  const eat = [new Uint16Array(N), new Uint16Array(N)];
  const e = a.eats;
  for (let i = 0; i < e.length; i += 5) { const layer = eat[e[i + 2]]; if (layer[e[i + 1]] < 65535) layer[e[i + 1]]++; }
  const deaths = new Int32Array(a.deaths.length * 6);
  a.deaths.forEach((d, i) => deaths.set([d.r, d.team, CAUSE_INDEX[d.cause], d.len, d.cell, d.killerTeam], i * 6));
  const tl = a.timeline;
  const i16 = (arr) => Int16Array.from(arr, (v) => Math.min(32767, v));
  return {
    fingerprint: fingerprint(a),
    formatVersion: a.formatVersion, botA: a.botA, botB: a.botB, map: a.map, geometry: a.geometry, rounds: a.rounds,
    winner: a.winner, endReason: a.endReason, result: a.result, teams: a.teams, flow: a.flow,
    firstBlood: a.firstBlood, leadChanges: a.leadChanges, decisiveRound: a.decisiveRound, check: a.check,
    timeline: { lenA: i16(tl.lenA), lenB: i16(tl.lenB), countA: i16(tl.countA), countB: i16(tl.countB),
      eatA: i16(tl.eatA), eatB: i16(tl.eatB), longA: i16(tl.longA), longB: i16(tl.longB) },
    layers: { body: a.heat.body.map(clamp16), head: a.heat.head.map(clamp16), eat },
    deaths,
  };
}

const transferables = (game) => {
  const list = [];
  const add = (x) => { if (x && x.buffer instanceof ArrayBuffer && !list.includes(x.buffer)) list.push(x.buffer); };
  if (game.layers) { game.layers.body.forEach(add); game.layers.head.forEach(add); game.layers.eat.forEach(add); }
  if (game.timeline) Object.values(game.timeline).forEach(add);
  add(game.deaths);
  return list;
};

self.onmessage = async (msg) => {
  const { id, bytes, detail } = msg.data;
  try {
    const rep = await decodeReplay(new Uint8Array(bytes), { logs: detail });
    const a = analyse(rep, { detail });
    if (detail) {
      self.postMessage({ id, ok: true, game: a });
      return;
    }
    const game = summarise(a);
    self.postMessage({ id, ok: true, game }, transferables(game));
  } catch (err) {
    // Bounds and format errors from a file that isn't a replay read better in plain words.
    const raw = String(err?.message || err);
    const error = err instanceof RangeError || /Cap'n Proto|no root|truncated|pointer|no map|DataView/i.test(raw)
      ? "Not a Battlecode replay, or it's damaged: it couldn't be decoded"
      : raw;
    self.postMessage({ id, ok: false, error });
  }
};
