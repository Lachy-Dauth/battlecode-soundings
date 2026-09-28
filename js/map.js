// Map text parser and board geometry, following engine/src/config.cc and
// engine/src/helpers.cc from the public UNSW Battlecode toolkit (MIT).
//
// Cells are indexed y * width + x. Edges: the horizontal edge (x, y) is the
// top side of cell (x, y); the vertical edge (x, y) is its left side. The
// board is a torus, so the bottom side of the last row is edge (x, 0).

export const EDGE_EMPTY = 0, EDGE_KELP = 1, EDGE_PORTAL = 2;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; // N E S W

export function parseMap(text) {
  const m = {
    name: '', width: 0, height: 0, symmetry: 'none', unitLimit: 64,
    beds: null, bedMin: null, bedMax: null, hKind: null, vKind: null, hPartner: null, vPartner: null,
    portalOf: [], dragons: [], text,
  };
  const portalEnds = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line === 'END') break;
    const f = line.trim().split(/\s+/);
    const key = f[0];
    if (key === 'MAP') {
      m.width = +f[1]; m.height = +f[2];
      const n = m.width * m.height;
      m.beds = new Uint8Array(n); m.bedMin = new Uint16Array(n); m.bedMax = new Uint16Array(n);
      m.hKind = new Uint8Array(n); m.vKind = new Uint8Array(n);
      m.hPartner = new Int32Array(n).fill(-1); m.vPartner = new Int32Array(n).fill(-1);
      m.hPortal = new Int32Array(n).fill(-1); m.vPortal = new Int32Array(n).fill(-1);
    } else if (key === 'MAP_NAME') {
      m.name = line.slice(line.indexOf('MAP_NAME') + 8).trim();
    } else if (key === 'UNIT_LIMIT') {
      m.unitLimit = +f[1];
    } else if (key === 'SYMMETRY') {
      m.symmetry = f[1] || 'none';
    } else if (key === 'TILE') {
      const x = +f[1], y = +f[2], min = +f[3], max = +f[4];
      const c = y * m.width + x;
      if (max > 0) { m.beds[c] = 1; m.bedMin[c] = min; m.bedMax[c] = max; }
    } else if (key === 'EDGE') {
      const idx = +f[1], kind = +f[2], portal = +f[3];
      const stride = m.width + 1, col = idx % stride, row = Math.floor(idx / stride);
      let orient, x, y;
      if (row % 2 === 0) {
        if (col === m.width || row === 2 * m.height) continue; // padding / wrapped duplicate
        orient = 'h'; x = col; y = row / 2;
      } else {
        if (col === m.width) continue;
        orient = 'v'; x = col; y = (row - 1) / 2;
      }
      const c = y * m.width + x;
      const kinds = orient === 'h' ? m.hKind : m.vKind;
      kinds[c] = kind === 1 ? EDGE_KELP : kind === 2 ? EDGE_PORTAL : EDGE_EMPTY;
      if (kind === 2) {
        (orient === 'h' ? m.hPortal : m.vPortal)[c] = portal;
        if (!portalEnds.has(portal)) portalEnds.set(portal, []);
        portalEnds.get(portal).push({ orient, c });
      }
    } else if (key === 'DRAGON') {
      const team = +f[1], count = +f[2];
      const body = [];
      for (let i = 0; i < count; i++) body.push(+f[4 + 2 * i] * m.width + +f[3 + 2 * i]);
      m.dragons.push({ id: m.dragons.length, team, body });
    }
  }
  if (!m.width) throw new Error('replay has no map');
  for (const [id, ends] of portalEnds) {
    if (ends.length !== 2) continue;
    const [a, b] = ends;
    (a.orient === 'h' ? m.hPartner : m.vPartner)[a.c] = b.c;
    (b.orient === 'h' ? m.hPartner : m.vPartner)[b.c] = a.c;
    m.portalOf.push({ id, orient: a.orient, a: a.c, b: b.c });
  }
  return m;
}

/** Cell reached by stepping from `cell` in `dir` (0 N, 1 E, 2 S, 3 W); -1 means kelp. */
export function stepFrom(m, cell, dir) {
  const W = m.width, H = m.height;
  const x = cell % W, y = (cell - x) / W;
  let kind, partner, orient;
  if (dir === 0) { const c = y * W + x; kind = m.hKind[c]; partner = m.hPartner[c]; orient = 'h'; }
  else if (dir === 2) { const c = ((y + 1) % H) * W + x; kind = m.hKind[c]; partner = m.hPartner[c]; orient = 'h'; }
  else if (dir === 3) { const c = y * W + x; kind = m.vKind[c]; partner = m.vPartner[c]; orient = 'v'; }
  else { const c = y * W + (x + 1) % W; kind = m.vKind[c]; partner = m.vPartner[c]; orient = 'v'; }
  if (kind === EDGE_KELP) return -1;
  if (kind === EDGE_PORTAL && partner >= 0) {
    const px = partner % W, py = (partner - px) / W;
    if (orient === 'h') return (((dir === 2 ? py : py - 1) + H) % H) * W + px;
    return py * W + (((dir === 1 ? px : px - 1) + W) % W);
  }
  return ((y + DY[dir] + H) % H) * W + ((x + DX[dir] + W) % W);
}

/** Direction that steps from `a` to `b`, or -1 if they aren't neighbours. */
export function stepBetween(m, a, b) {
  for (let d = 0; d < 4; d++) if (stepFrom(m, a, d) === b) return d;
  return -1;
}

/** The cell's mirror image under the map's symmetry (itself when there is none). */
export function mirrorCell(m, cell) {
  const W = m.width, H = m.height, x = cell % W, y = (cell - x) / W;
  switch (m.symmetry) {
    case 'x': return (H - 1 - y) * W + x;
    case 'y': return y * W + (W - 1 - x);
    case 'xy': return (H - 1 - y) * W + (W - 1 - x);
    default: return cell;
  }
}

/** Mean respawn gap of each pearl bed, in rounds (0 = not a bed). */
export function bedRate(m, cell) {
  return m.beds[cell] ? (m.bedMin[cell] + m.bedMax[cell]) / 2 : 0;
}
