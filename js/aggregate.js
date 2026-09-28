// Everything computed across loaded games, from "your" point of view.
import { CAUSES } from './analyse.js';

/**
 * Which side a game's player is, under the chosen perspective: 0 (A), 1 (B)
 * or -1 (not in this game). `popular` comes from botPopularity().
 */
export function resolveSide(g, perspective, popular) {
  const a = g.botA, b = g.botB;
  if (perspective === 'A') return 0;
  if (perspective === 'B') return 1;
  if (perspective.startsWith('bot:')) {
    const name = perspective.slice(4);
    return a === name ? 0 : b === name ? 1 : -1;
  }
  // auto: a server download names only the downloader's bot, so that side is you.
  if (a && !b) return 0;
  if (b && !a) return 1;
  // Local runs name both: you are the one name that recurs across the batch.
  if (a && b) {
    if (a === popular.you) return 0;
    if (b === popular.you) return 1;
    return (popular.get(b) || 0) > (popular.get(a) || 0) ? 1 : 0;
  }
  return 0;
}

/**
 * Name counts across games. `.you` is the auto-detected player among games that
 * name both sides: the most frequent name, ties going to the name seen more
 * often as team A, then alphabetically, so every game agrees on one choice.
 */
export function botPopularity(games) {
  const m = new Map(), asA = new Map(), inBoth = new Set();
  for (const x of games) {
    const { botA: a, botB: b } = x.g;
    for (const n of [a, b]) if (n) m.set(n, (m.get(n) || 0) + 1);
    if (a && b) { inBoth.add(a); inBoth.add(b); asA.set(a, (asA.get(a) || 0) + 1); }
  }
  m.you = [...inBoth].sort((p, q) => (m.get(q) - m.get(p)) || ((asA.get(q) || 0) - (asA.get(p) || 0)) || p.localeCompare(q))[0] ?? null;
  return m;
}

export const botLabel = (name) => (!name ? 'Unknown' : /^\d+$/.test(name) ? `Submission ${name}` : name);

export function outcome(g, side) {
  if (!g.winner) return 'draw';
  return (g.winner === 'A' ? 0 : 1) === side ? 'win' : 'loss';
}

const SUM_KEYS = ['lost', 'lenLost', 'kills', 'killLen', 'bodyKills', 'headKills', 'eaten', 'eatenNatural',
  'eatenOwnCorpse', 'eatenEnemyCorpse', 'dropped', 'droppedEatenByOwn', 'droppedEatenByEnemy', 'moves', 'steps',
  'sprints', 'sprintPaid', 'splits', 'splitSegments', 'pings', 'turns', 'measuredTurns', 'instrSum', 'tle', 'exceeded',
  'peakDragons', 'peakTotal', 'peakLongest', 'finalDragons', 'finalTotal', 'finalLongest', 'startDragons', 'startLength', 'born',
  'logs', 'engineNotes'];

function emptySide() {
  const s = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
  s.lostBy = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  s.lenLostBy = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  s.pingKinds = new Array(7).fill(0);
  s.instrMax = 0;
  s.instrHist = new Array(24).fill(0);
  return s;
}

function addSide(acc, t) {
  for (const k of SUM_KEYS) acc[k] += t[k] || 0;
  for (const c of CAUSES) { acc.lostBy[c] += t.lostBy[c] || 0; acc.lenLostBy[c] += t.lenLostBy[c] || 0; }
  for (let i = 0; i < acc.pingKinds.length; i++) acc.pingKinds[i] += t.pingKinds?.[i] || 0;
  for (let i = 0; i < acc.instrHist.length; i++) acc.instrHist[i] += t.instrHist?.[i] || 0;
  if (t.instrMax > acc.instrMax) acc.instrMax = t.instrMax;
}

/** Games passing the filters, each with the side "you" played. */
export function selectGames(games, { perspective, filters }) {
  const popular = botPopularity(games);
  const out = [];
  for (const x of games) {
    const side = resolveSide(x.g, perspective, popular);
    if (side < 0) continue;
    const g = x.g;
    const you = side === 0 ? g.botA : g.botB;
    const opp = side === 0 ? g.botB : g.botA;
    const res = outcome(g, side);
    if (filters.map !== 'all' && g.map.key !== filters.map) continue;
    if (filters.result !== 'all' && res !== filters.result) continue;
    if (filters.bot !== 'all' && you !== filters.bot) continue;
    if (filters.opp !== 'all' && opp !== filters.opp) continue;
    out.push({ ...x, side, you, opp, res });
  }
  return out;
}

export function aggregate(sel) {
  const agg = { n: sel.length, win: 0, loss: 0, draw: 0, rounds: 0, you: emptySide(), opp: emptySide(),
    byMap: new Map(), byBot: new Map(), byOpp: new Map(), firstBloodYou: 0, firstBloodOpp: 0, elimWins: 0, elimLosses: 0,
    flow: { natural: [0, 0], yourCorpses: [0, 0], theirCorpses: [0, 0], spawnedNatural: 0, droppedYou: 0, droppedOpp: 0 } };
  for (const x of sel) {
    const g = x.g, s = x.side, o = 1 - s;
    agg[x.res]++;
    agg.rounds += g.rounds;
    addSide(agg.you, g.teams[s]);
    addSide(agg.opp, g.teams[o]);
    if (g.firstBlood) g.firstBlood.team === s ? agg.firstBloodYou++ : agg.firstBloodOpp++;
    if (g.endReason === 'teamEliminated') { if (x.res === 'win') agg.elimWins++; else if (x.res === 'loss') agg.elimLosses++; }
    // Pearl flow from your side: flow[src][eaterTeam]; src 0 natural, 1 A corpse, 2 B corpse.
    const f = g.flow;
    agg.flow.natural[0] += f[0][s]; agg.flow.natural[1] += f[0][o];
    agg.flow.yourCorpses[0] += f[1 + s][s]; agg.flow.yourCorpses[1] += f[1 + s][o];
    agg.flow.theirCorpses[0] += f[1 + o][s]; agg.flow.theirCorpses[1] += f[1 + o][o];
    agg.flow.spawnedNatural += f[0][2]; agg.flow.droppedYou += f[1 + s][2]; agg.flow.droppedOpp += f[1 + o][2];
    for (const [key, map, label] of [[g.map.key, agg.byMap, g.map.name], [x.you || '', agg.byBot, botLabel(x.you)], [x.opp || '', agg.byOpp, botLabel(x.opp)]]) {
      if (!map.has(key)) map.set(key, { key, label, n: 0, win: 0, loss: 0, draw: 0, rounds: 0, youEat: 0, oppEat: 0,
        youLost: 0, oppLost: 0, youKills: 0, oppKills: 0, youLenLost: 0, youSelf: 0, youFinal: 0, oppFinal: 0, map: g.map });
      const b = map.get(key);
      b.n++; b[x.res]++; b.rounds += g.rounds;
      b.youEat += g.teams[s].eaten; b.oppEat += g.teams[o].eaten;
      b.youLost += g.teams[s].lost; b.oppLost += g.teams[o].lost;
      b.youKills += g.teams[s].kills; b.oppKills += g.teams[o].kills;
      b.youLenLost += g.teams[s].lenLost;
      b.youSelf += selfInflicted(g.teams[s]);
      b.youFinal += g.teams[s].finalTotal; b.oppFinal += g.teams[o].finalTotal;
    }
  }
  return agg;
}

export const selfInflicted = (t, by = 'lostBy') => CAUSES.filter((c) => c !== 'enemyBody' && c !== 'enemyHead').reduce((s, c) => s + (t[by][c] || 0), 0);
export const enemyInflicted = (t, by = 'lostBy') => (t[by].enemyBody || 0) + (t[by].enemyHead || 0);

/** Mean and quartiles of a per-round series across games, for rounds that at least `minN` games reached. */
export function seriesStats(sel, pick, maxRound = 500, minN = 3) {
  const cols = [];
  for (const x of sel) {
    const arr = pick(x);
    if (!arr) continue;
    for (let r = 0; r < Math.min(arr.length, maxRound); r++) (cols[r] ||= []).push(arr[r]);
  }
  const out = { mean: [], p25: [], p75: [], n: [] };
  for (let r = 0; r < cols.length; r++) {
    const c = cols[r];
    if (!c || c.length < Math.min(minN, sel.length)) break;
    c.sort((a, b) => a - b);
    const q = (p) => c[Math.min(c.length - 1, Math.floor(p * (c.length - 1) + 0.5))];
    out.mean.push(c.reduce((a, b) => a + b, 0) / c.length);
    out.p25.push(q(0.25)); out.p75.push(q(0.75)); out.n.push(c.length);
  }
  return out;
}

/** Mirror a cell onto the other half of a symmetric map. */
export function mirror(geom, cell) {
  const W = geom.width, H = geom.height, x = cell % W, y = (cell - x) / W;
  switch (geom.symmetry) {
    case 'x': return (H - 1 - y) * W + x;
    case 'y': return y * W + (W - 1 - x);
    case 'xy': return (H - 1 - y) * W + (W - 1 - x);
    default: return cell;
  }
}

/**
 * Sum a map's layers across games. With `flip`, games where you were team B
 * are mirrored so you always start on team A's side.
 * layer: 'body' | 'head' | 'eat' (dense) or 'deaths' | 'kills' (from the death list).
 */
export function mapLayer(sel, geom, { layer, who, flip, causes, fromRound = 0, toRound = 9999 }) {
  const N = geom.width * geom.height;
  const out = new Float32Array(N);
  let games = 0;
  const canFlip = flip && geom.symmetry !== 'none';
  for (const x of sel) {
    if (x.g.map.width !== geom.width || x.g.map.height !== geom.height) continue;
    const team = who === 'you' ? x.side : 1 - x.side;
    const needFlip = canFlip && x.side === 1;
    games++;
    if (layer === 'body' || layer === 'head' || layer === 'eat') {
      const src = x.g.layers[layer][team];
      if (needFlip) for (let c = 0; c < N; c++) out[mirror(geom, c)] += src[c];
      else for (let c = 0; c < N; c++) out[c] += src[c];
    } else {
      const d = x.g.deaths;
      for (let i = 0; i < d.length; i += 6) {
        const r = d[i], victim = d[i + 1], cause = CAUSES[d[i + 2]], cell = d[i + 4], killerTeam = d[i + 5];
        if (r < fromRound || r > toRound) continue;
        if (layer === 'deaths' && victim !== team) continue;
        if (layer === 'kills' && !(killerTeam === team && victim !== team)) continue;
        if (causes && !causes.has(cause)) continue;
        out[needFlip ? mirror(geom, cell) : cell] += 1;
      }
    }
  }
  return { values: out, games };
}
