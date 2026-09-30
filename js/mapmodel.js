// An editable map: parse and write the engine's .map format, mirror edits
// across the map's symmetry, check a map the way the engine's loader does,
// and measure what it gives each side.
//
// Edges are { o: 'h' | 'v', c }: the horizontal edge of cell c is its top
// side, the vertical edge its left side (engine/src/helpers.cc).

import { parseMap, stepFrom, EDGE_EMPTY, EDGE_KELP, EDGE_PORTAL } from './map.js';

export { EDGE_EMPTY, EDGE_KELP, EDGE_PORTAL };

/** Bed spawn gaps (min–max rounds between pearls), from the gaps real maps use. */
export const BED_PRESETS = [
  { id: 'r1', label: 'Every round', min: 1, max: 1 },
  { id: 'r10', label: '1–10', min: 1, max: 10 },
  { id: 'r50', label: '1–50', min: 1, max: 50 },
  { id: 'r200', label: '1–200', min: 1, max: 200 },
  { id: 'r750', label: '1–750', min: 1, max: 750 },
  { id: 'r2000', label: '1–2000', min: 1, max: 2000 },
  { id: 'none', label: 'No bed', min: 0, max: 0 },
];

export function blankModel({ width = 24, height = 24, symmetry = 'xy', name = 'Untitled', bed = { min: 1, max: 750 } } = {}) {
  const n = width * height;
  const m = {
    name, width, height, symmetry, unitLimit: 64,
    beds: new Uint8Array(n), bedMin: new Uint16Array(n), bedMax: new Uint16Array(n),
    hKind: new Uint8Array(n), vKind: new Uint8Array(n),
    hPortal: new Int32Array(n).fill(-1), vPortal: new Int32Array(n).fill(-1),
    dragons: [],
  };
  if (bed && bed.max > 0) for (let c = 0; c < n; c++) { m.beds[c] = 1; m.bedMin[c] = bed.min; m.bedMax[c] = bed.max; }
  // One dragon a side, mirrored, so a new map is playable straight away.
  const y = Math.floor(height / 2), x = Math.max(2, Math.floor(width / 6));
  const a = { team: 0, body: [y * width + x + 1, y * width + x] };
  m.dragons.push(a);
  const b = mirrorDragon(m, a);
  if (b && !overlaps(m, b.body)) m.dragons.push(b);
  return m;
}

export function fromText(text, fallbackName = 'Untitled') {
  const p = parseMap(text);
  return {
    name: p.name || fallbackName, width: p.width, height: p.height, symmetry: p.symmetry || 'none', unitLimit: p.unitLimit,
    beds: p.beds, bedMin: p.bedMin, bedMax: p.bedMax, hKind: p.hKind, vKind: p.vKind,
    hPortal: p.hPortal, vPortal: p.vPortal,
    dragons: p.dragons.map((d) => ({ team: d.team, body: d.body.slice() })),
  };
}

/** A map from a replay's geometry (the Maps view), so any played map can be opened for editing. */
export function fromGeometry(g, name) {
  const n = g.width * g.height;
  const m = {
    name: name || 'Untitled', width: g.width, height: g.height, symmetry: g.symmetry || 'none', unitLimit: 64,
    beds: Uint8Array.from(g.beds), bedMin: Uint16Array.from(g.bedMin), bedMax: Uint16Array.from(g.bedMax),
    hKind: Uint8Array.from(g.hKind), vKind: Uint8Array.from(g.vKind),
    hPortal: new Int32Array(n).fill(-1), vPortal: new Int32Array(n).fill(-1),
    dragons: (g.spawns || []).map((s) => ({ team: s.team, body: Array.from(s.body) })),
  };
  for (const p of g.portals || []) {
    const arr = p.orient === 'h' ? m.hPortal : m.vPortal;
    arr[p.a] = p.id; arr[p.b] = p.id;
  }
  return m;
}

export function clone(m) {
  return {
    ...m, beds: m.beds.slice(), bedMin: m.bedMin.slice(), bedMax: m.bedMax.slice(), hKind: m.hKind.slice(), vKind: m.vKind.slice(),
    hPortal: m.hPortal.slice(), vPortal: m.vPortal.slice(), dragons: m.dragons.map((d) => ({ team: d.team, body: d.body.slice() })),
  };
}

// ---- writing ------------------------------------------------------------------

/** The .map text, laid out like the toolkit's own maps (every tile, then non-empty edges by index). */
export function toText(m) {
  const W = m.width, H = m.height, out = [`MAP ${W} ${H}`];
  if (m.symmetry && m.symmetry !== 'none') out.push(`SYMMETRY ${m.symmetry}`);
  out.push(`MAP_NAME ${m.name.replace(/[\r\n]+/g, ' ').trim() || 'Untitled'}`);
  if (m.unitLimit && m.unitLimit !== 64) out.push(`UNIT_LIMIT ${m.unitLimit}`);
  out.push(`TILE_COUNT ${W * H}`);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x;
    out.push(`TILE ${x} ${y} ${m.beds[c] ? m.bedMin[c] : 0} ${m.beds[c] ? m.bedMax[c] : 0}`);
  }
  const edges = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y * W + x;
    for (const [o, kinds, portals, row] of [['h', m.hKind, m.hPortal, 2 * y], ['v', m.vKind, m.vPortal, 2 * y + 1]]) {
      const k = kinds[c];
      if (!k) continue;
      edges.push([row * (W + 1) + x, k, k === EDGE_PORTAL ? portals[c] : -1]);
    }
  }
  edges.sort((a, b) => a[0] - b[0]);
  out.push(`EDGE_COUNT ${edges.length}`, ...edges.map((e) => `EDGE ${e[0]} ${e[1]} ${e[2]}`));
  out.push(`DRAGON_COUNT ${m.dragons.length}`);
  for (const d of m.dragons) out.push(`DRAGON ${d.team} ${d.body.length} ${d.body.map((c) => `${c % W} ${Math.floor(c / W)}`).join(' ')}`);
  out.push('END', '');
  return out.join('\n');
}

// ---- geometry helpers ------------------------------------------------------------------

export function portalPairs(m) {
  const ends = new Map();
  for (const [o, arr] of [['h', m.hPortal], ['v', m.vPortal]]) {
    const kinds = o === 'h' ? m.hKind : m.vKind;
    for (let c = 0; c < arr.length; c++) {
      if (kinds[c] !== EDGE_PORTAL) continue;
      if (!ends.has(arr[c])) ends.set(arr[c], []);
      ends.get(arr[c]).push({ o, c });
    }
  }
  const pairs = [], broken = [];
  for (const [id, list] of ends) {
    if (list.length === 2 && list[0].o === list[1].o) pairs.push({ id, orient: list[0].o, a: list[0].c, b: list[1].c });
    else broken.push({ id, ends: list });
  }
  return { pairs, broken };
}

/** The model plus the partner arrays stepFrom() needs to walk through portals. */
export function walkable(m) {
  const n = m.width * m.height;
  const hPartner = new Int32Array(n).fill(-1), vPartner = new Int32Array(n).fill(-1);
  for (const p of portalPairs(m).pairs) {
    const arr = p.orient === 'h' ? hPartner : vPartner;
    arr[p.a] = p.b; arr[p.b] = p.a;
  }
  return { ...m, hPartner, vPartner };
}

/** What the Board renderer draws. */
export function geometryOf(m) {
  return {
    width: m.width, height: m.height, symmetry: m.symmetry, hKind: m.hKind, vKind: m.vKind,
    beds: m.beds, bedMin: m.bedMin, bedMax: m.bedMax,
    portals: portalPairs(m).pairs, spawns: m.dragons,
  };
}

export function mirrorCell(m, c) {
  const W = m.width, H = m.height, x = c % W, y = (c - x) / W;
  switch (m.symmetry) {
    case 'x': return (H - 1 - y) * W + x;
    case 'y': return y * W + (W - 1 - x);
    case 'xy': return (H - 1 - y) * W + (W - 1 - x);
    default: return c;
  }
}

/** The edge that mirrors `e` under the map's symmetry (a cell's left side mirrors to its twin's right side). */
export function mirrorEdge(m, e) {
  const W = m.width, H = m.height, x = e.c % W, y = (e.c - x) / W;
  const s = m.symmetry;
  if (s === 'none') return e;
  if (e.o === 'h') {
    const nx = s === 'y' || s === 'xy' ? W - 1 - x : x;
    const ny = s === 'x' || s === 'xy' ? (H - y) % H : y;
    return { o: 'h', c: ny * W + nx };
  }
  const nx = s === 'y' || s === 'xy' ? (W - x) % W : x;
  const ny = s === 'x' || s === 'xy' ? H - 1 - y : y;
  return { o: 'v', c: ny * W + nx };
}

export function mirrorDragon(m, d) {
  if (m.symmetry === 'none') return null;
  return { team: 1 - d.team, body: d.body.map((c) => mirrorCell(m, c)) };
}

export function overlaps(m, body, ignore = null) {
  const cells = new Set(body);
  if (cells.size !== body.length) return true;
  for (const d of m.dragons) if (d !== ignore && d.body.some((c) => cells.has(c))) return true;
  return false;
}

export function dragonAt(m, c) {
  return m.dragons.find((d) => d.body.includes(c)) || null;
}

export function edgeKind(m, e) { return (e.o === 'h' ? m.hKind : m.vKind)[e.c]; }
export function setEdge(m, e, kind, portal = -1) {
  (e.o === 'h' ? m.hKind : m.vKind)[e.c] = kind;
  (e.o === 'h' ? m.hPortal : m.vPortal)[e.c] = kind === EDGE_PORTAL ? portal : -1;
}
export function edgePortal(m, e) { return (e.o === 'h' ? m.hPortal : m.vPortal)[e.c]; }
export function nextPortalId(m) {
  let max = -1;
  for (const arr of [m.hPortal, m.vPortal]) for (const v of arr) if (v > max) max = v;
  return max + 1;
}

// ---- resize / symmetrize ----------------------------------------------------------------

/** A copy at a new size, anchored top-left; dragons that no longer fit are dropped. */
export function resize(m, W, H) {
  const out = blankModel({ width: W, height: H, symmetry: m.symmetry, name: m.name, bed: null });
  out.dragons = [];
  out.unitLimit = m.unitLimit;
  for (let y = 0; y < Math.min(H, m.height); y++) for (let x = 0; x < Math.min(W, m.width); x++) {
    const a = y * m.width + x, b = y * W + x;
    out.beds[b] = m.beds[a]; out.bedMin[b] = m.bedMin[a]; out.bedMax[b] = m.bedMax[a];
    out.hKind[b] = m.hKind[a]; out.vKind[b] = m.vKind[a]; out.hPortal[b] = m.hPortal[a]; out.vPortal[b] = m.vPortal[a];
  }
  for (const d of m.dragons) {
    const cells = d.body.map((c) => [c % m.width, Math.floor(c / m.width)]);
    if (cells.every(([x, y]) => x < W && y < H)) out.dragons.push({ team: d.team, body: cells.map(([x, y]) => y * W + x) });
  }
  // Portals that lost an end become plain kelp-free edges.
  for (const p of portalPairs(out).broken) for (const e of p.ends) setEdge(out, e, EDGE_EMPTY);
  return out;
}

/** Which half "Copy half" copies from, in words. */
export function sourceHalf(m) {
  return { y: 'left half onto the right', x: 'top half onto the bottom', xy: 'top half onto the bottom, rotated' }[m.symmetry] || null;
}

/** Copy the top/left half (by cell index) onto its mirror: kelp, beds, portals and dragons (with teams swapped). */
export function symmetrize(m) {
  if (m.symmetry === 'none') return clone(m);
  const out = clone(m);
  const N = m.width * m.height;
  // Cells: the half whose index is not greater than its mirror's is team A's.
  for (let c = 0; c < N; c++) {
    const t = mirrorCell(m, c);
    if (t <= c) continue;
    out.beds[t] = m.beds[c]; out.bedMin[t] = m.bedMin[c]; out.bedMax[t] = m.bedMax[c];
  }
  // Edges: keep kelp from the canonical side of each mirrored pair.
  for (const o of ['h', 'v']) {
    for (let c = 0; c < N; c++) {
      const e = { o, c }, t = mirrorEdge(m, e);
      if (t.c < c || (t.c === c)) continue;
      const k = edgeKind(m, e);
      if (k === EDGE_PORTAL) continue;
      if (edgeKind(out, t) !== EDGE_PORTAL) setEdge(out, t, k);
    }
  }
  // Portals: mirror every pair that has an end on the canonical side.
  let id = nextPortalId(out);
  for (const p of portalPairs(m).pairs) {
    const a = mirrorEdge(m, { o: p.orient, c: p.a }), b = mirrorEdge(m, { o: p.orient, c: p.b });
    const same = (a.c === p.a && b.c === p.b) || (a.c === p.b && b.c === p.a);
    if (same || edgeKind(out, a) === EDGE_PORTAL || edgeKind(out, b) === EDGE_PORTAL) continue;
    setEdge(out, a, EDGE_PORTAL, id); setEdge(out, b, EDGE_PORTAL, id); id++;
  }
  // Dragons: those with their head in the source half stay, the rest become their mirrors.
  out.dragons = m.dragons.filter((d) => d.body[0] <= mirrorCell(m, d.body[0])).map((d) => ({ team: d.team, body: d.body.slice() }));
  for (const d of out.dragons.slice()) {
    const twin = mirrorDragon(m, d);
    if (twin && !overlaps(out, twin.body)) out.dragons.push(twin);
  }
  return out;
}

// ---- checks ---------------------------------------------------------------------------------

/**
 * Errors are what the engine's loader rejects or a map can't be played with;
 * warnings are things that make a map unfair or odd but still load.
 */
export function validate(m) {
  const errors = [], warnings = [];
  const W = m.width, H = m.height, N = W * H;
  if (W < 7 || H < 7 || W > 256 || H > 256) errors.push(`Size must be between 7×7 and 256×256 (this is ${W}×${H}).`);
  if (!(m.unitLimit > 0)) errors.push('The unit limit must be positive.');

  let badGap = 0, bedMismatch = 0;
  for (let c = 0; c < N; c++) {
    if (m.beds[c] && (m.bedMin[c] > m.bedMax[c] || m.bedMax[c] <= 0)) badGap++;
    const t = mirrorCell(m, c);
    if (t > c && (m.beds[c] !== m.beds[t] || (m.beds[c] && (m.bedMin[c] !== m.bedMin[t] || m.bedMax[c] !== m.bedMax[t])))) bedMismatch++;
  }
  if (badGap) errors.push(`${badGap} pearl bed${badGap === 1 ? ' has' : 's have'} a minimum gap above the maximum.`);
  if (bedMismatch) errors.push(`${bedMismatch} pearl bed${bedMismatch === 1 ? ' differs' : 's differ'} from ${bedMismatch === 1 ? 'its' : 'their'} mirror image. The engine refuses maps like this under ${m.symmetry} symmetry.`);

  const { broken } = portalPairs(m);
  for (const b of broken) {
    if (b.ends.length !== 2) errors.push(`Portal ${b.id} has ${b.ends.length} end${b.ends.length === 1 ? '' : 's'}; it needs exactly two.`);
    else errors.push(`Portal ${b.id} joins a horizontal edge to a vertical one.`);
  }

  const wm = walkable(m);
  const seen = new Map();
  m.dragons.forEach((d, i) => {
    const label = `${d.team === 0 ? 'Team A' : 'Team B'} dragon ${i + 1}`;
    if (d.body.length < 2) errors.push(`${label} is shorter than 2.`);
    for (let k = 0; k < d.body.length; k++) {
      const c = d.body[k];
      if (c < 0 || c >= N) { errors.push(`${label} is off the map.`); return; }
      if (seen.has(c)) errors.push(`${label} overlaps ${seen.get(c)}.`);
      seen.set(c, label);
      if (k > 0) {
        let adjacent = false;
        for (let dir = 0; dir < 4; dir++) if (stepFrom(wm, d.body[k], dir) === d.body[k - 1]) adjacent = true;
        if (!adjacent) { errors.push(`${label}: segments ${k} and ${k + 1} aren't next to each other (or kelp is between them).`); break; }
      }
    }
  });
  const count = [0, 0], length = [0, 0];
  for (const d of m.dragons) { count[d.team]++; length[d.team] += d.body.length; }
  if (!count[0] || !count[1]) errors.push(`${!count[0] ? 'Team A' : 'Team B'} has no dragons, so the game would end in round 0.`);
  if (count[0] && count[1] && (count[0] !== count[1] || length[0] !== length[1])) {
    warnings.push(`The teams start unevenly: A has ${count[0]} dragons (length ${length[0]}), B has ${count[1]} (length ${length[1]}).`);
  }

  if (m.symmetry !== 'none') {
    let kelpOff = 0, portalOff = 0;
    for (const o of ['h', 'v']) for (let c = 0; c < N; c++) {
      const e = { o, c }, t = mirrorEdge(m, e), k = edgeKind(m, e), kt = edgeKind(m, t);
      if (k === EDGE_KELP && kt !== EDGE_KELP) kelpOff++;
      if (k === EDGE_PORTAL && kt !== EDGE_PORTAL) portalOff++;
    }
    if (kelpOff) warnings.push(`${kelpOff} kelp edge${kelpOff === 1 ? ' has' : 's have'} no mirror image, so one side gets walls the other doesn't.`);
    if (portalOff) warnings.push(`${portalOff} portal end${portalOff === 1 ? ' has' : 's have'} no mirror image.`);
    const unmatched = m.dragons.filter((d) => {
      const twin = mirrorDragon(m, d);
      return !m.dragons.some((o) => o.team === twin.team && o.body.length === twin.body.length && o.body.every((c, i) => c === twin.body[i]));
    }).length;
    if (unmatched) warnings.push(`${unmatched} dragon${unmatched === 1 ? ' has' : 's have'} no mirrored twin on the other team.`);
  }
  return { errors, warnings };
}

// ---- analysis --------------------------------------------------------------------------------

/** Steps from each team's nearest starting head to every cell (kelp blocks, portals and wrap-around count). */
export function distances(m) {
  const wm = walkable(m), N = m.width * m.height;
  const out = [new Int32Array(N).fill(-1), new Int32Array(N).fill(-1)];
  for (const team of [0, 1]) {
    const dist = out[team];
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    for (const d of m.dragons) if (d.team === team && d.body.length && dist[d.body[0]] < 0) { dist[d.body[0]] = 0; queue[tail++] = d.body[0]; }
    while (head < tail) {
      const c = queue[head++];
      for (let dir = 0; dir < 4; dir++) {
        const n = stepFrom(wm, c, dir);
        if (n >= 0 && dist[n] < 0) { dist[n] = dist[c] + 1; queue[tail++] = n; }
      }
    }
  }
  return out;
}

/** Pearls a bed makes per 100 rounds on average (ignoring spawns blocked by a pearl or a dragon). */
export const bedRate = (m, c) => (m.beds[c] ? 100 / Math.max(0.5, (m.bedMin[c] + m.bedMax[c]) / 2) : 0);

export function analyse(m) {
  const N = m.width * m.height;
  const [dA, dB] = distances(m);
  const rate = new Float32Array(N), closer = new Float32Array(N);
  let total = 0, toA = 0, toB = 0, tied = 0, unreachable = 0, beds = 0, reachCells = 0;
  for (let c = 0; c < N; c++) {
    const r = bedRate(m, c);
    rate[c] = r;
    if (m.beds[c]) beds++;
    const a = dA[c], b = dB[c];
    if (a < 0 && b < 0) { unreachable += r; closer[c] = 0; continue; }
    reachCells++;
    const side = a < 0 ? -1 : b < 0 ? 1 : Math.sign(b - a);
    closer[c] = side === 0 ? 0.0001 : side;
    total += r;
    if (side > 0) toA += r; else if (side < 0) toB += r; else tied += r;
  }
  let kelp = 0;
  for (let c = 0; c < N; c++) { if (m.hKind[c] === EDGE_KELP) kelp++; if (m.vKind[c] === EDGE_KELP) kelp++; }
  return {
    rate, closer, distA: dA, distB: dB, beds, kelp, portals: portalPairs(m).pairs.length,
    pearlsPer100: total + unreachable, reachable: total, toA, toB, tied, unreachable, reachCells, cells: N,
    dragons: [m.dragons.filter((d) => d.team === 0), m.dragons.filter((d) => d.team === 1)],
  };
}
