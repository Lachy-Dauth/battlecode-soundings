// Rebuilds a game from its event stream and measures it.
//
// The engine's rules (engine/docs.md, engine/src/actions.cc) make every
// replay event deterministic to follow: a DragonUpdate pushes a new head and
// drops tail cells until the reported tail; a death turns every other segment
// into a pearl; a pearl only ever disappears by being eaten. Following them
// with a board of who-occupies-what lets us say who killed whom and where
// every eaten pearl came from, which the replay doesn't record directly.

import { EV } from './replay.js';
import { parseMap, stepFrom } from './map.js';

/** How a dragon died, from the engine's five reasons plus what we can work out. */
export const CAUSES = ['enemyBody', 'enemyHead', 'wall', 'self', 'allyBody', 'allyHead', 'sprint', 'badSplit', 'noMove', 'timeout'];
export const CAUSE_LABEL = {
  enemyBody: 'Ran into an enemy', enemyHead: 'Head-on with an enemy', wall: 'Hit kelp', self: 'Hit its own body',
  allyBody: 'Ran into a teammate', allyHead: 'Head-on with a teammate', sprint: 'Sprinted too far',
  badSplit: 'Invalid split', noMove: 'No valid move', timeout: 'Timed out',
};
export const ENEMY_CAUSES = new Set(['enemyBody', 'enemyHead']);
export const SRC = { NATURAL: 1, CORPSE_A: 2, CORPSE_B: 3 };
const SONAR_KIND_COUNT = 7;

function newTeam() {
  const zero = () => Object.fromEntries(CAUSES.map((c) => [c, 0]));
  return {
    startDragons: 0, startLength: 0, born: 0, lost: 0, lostBy: zero(), lenLostBy: zero(), lenLost: 0,
    kills: 0, killLen: 0, bodyKills: 0, headKills: 0,
    eaten: 0, eatenNatural: 0, eatenOwnCorpse: 0, eatenEnemyCorpse: 0,
    dropped: 0, droppedEatenByOwn: 0, droppedEatenByEnemy: 0,
    moves: 0, steps: 0, sprints: 0, sprintPaid: 0, splits: 0, splitSegments: 0,
    pings: 0, pingKinds: new Array(SONAR_KIND_COUNT).fill(0),
    turns: 0, measuredTurns: 0, instrSum: 0, instrMax: 0, tle: 0, exceeded: 0, instrHist: new Array(24).fill(0),
    peakDragons: 0, peakTotal: 0, peakLongest: 0, finalDragons: 0, finalTotal: 0, finalLongest: 0,
    logs: 0, engineNotes: 0,
  };
}

/**
 * @param rep     decoded replay (see replay.js)
 * @param detail  also keep per-round snapshots, lifelines, logs and sonar rays
 */
export function analyse(rep, { detail = false } = {}) {
  const map = parseMap(rep.map);
  const W = map.width, H = map.height, N = W * H;
  const occ = new Int32Array(N).fill(-1);
  const pearlSrc = new Uint8Array(N);
  const teams = [newTeam(), newTeam()];
  const heat = {
    body: [new Uint32Array(N), new Uint32Array(N)],
    head: [new Uint32Array(N), new Uint32Array(N)],
  };
  const drag = new Map();
  const dragons = [];
  const deaths = [];
  const eats = [];
  const splits = [];
  const check = { unresolvedKills: 0, unknownPearls: 0, bodyMismatch: 0 };

  const tl = { lenA: [], lenB: [], longA: [], longB: [], countA: [], countB: [], eatA: [], eatB: [], lostA: [], lostB: [], pearls: [] };
  const snaps = detail ? { bodies: [], pearls: [] } : null;
  const logs = detail ? [] : null;
  const rays = detail ? [] : null;
  const turnActions = detail ? [] : null;

  const addDragon = (id, team, body, parent, born) => {
    const d = { id, team, body, parent, born, died: -1, cause: null, alive: true, maxLen: body.length,
      lenAtDeath: 0, eaten: 0, steps: 0, kills: 0, children: 0, lens: detail ? [] : null };
    drag.set(id, d);
    dragons.push(d);
    for (const c of body) occ[c] = id;
    return d;
  };
  for (const d0 of map.dragons) {
    addDragon(d0.id, d0.team, d0.body.slice(), -1, 0);
    teams[d0.team].startDragons++;
    teams[d0.team].startLength += d0.body.length;
  }

  let onBoard = 0;
  const flow = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // [natural, corpseA, corpseB] x [eaten by A, eaten by B, spawned]
  let firstBlood = null;

  const endRound = (r) => {
    const count = [0, 0], total = [0, 0], longest = [0, 0];
    for (const d of dragons) {
      if (!d.alive) continue;
      const len = d.body.length;
      count[d.team]++; total[d.team] += len;
      if (len > longest[d.team]) longest[d.team] = len;
      const layer = heat.body[d.team];
      for (let i = 0; i < len; i++) layer[d.body[i]]++;
      if (detail) d.lens.push(len);
    }
    tl.lenA.push(total[0]); tl.lenB.push(total[1]);
    tl.longA.push(longest[0]); tl.longB.push(longest[1]);
    tl.countA.push(count[0]); tl.countB.push(count[1]);
    tl.eatA.push(teams[0].eaten); tl.eatB.push(teams[1].eaten);
    tl.lostA.push(teams[0].lenLost); tl.lostB.push(teams[1].lenLost);
    tl.pearls.push(onBoard);
    for (let t = 0; t < 2; t++) {
      const s = teams[t];
      if (count[t] > s.peakDragons) s.peakDragons = count[t];
      if (total[t] > s.peakTotal) s.peakTotal = total[t];
      if (longest[t] > s.peakLongest) s.peakLongest = longest[t];
    }
    if (detail) {
      const b = [];
      for (const d of dragons) if (d.alive) b.push(d.id, d.team, d.body.length, ...d.body);
      snaps.bodies.push(Int32Array.from(b));
      const p = [];
      for (let c = 0; c < N; c++) if (pearlSrc[c]) p.push(c, pearlSrc[c]);
      snaps.pearls.push(Int32Array.from(p));
    }
  };

  let round = -1, turn = -1, act = null, stepsDone = 0, inTurn = false, dropFrom = null, headOnWith = -1;
  const closeTurn = () => {
    if (!act) return;
    const d = drag.get(act.id);
    if (!d) return;
    const s = teams[d.team];
    if (act.kind === 'move') {
      s.moves++;
      if (act.steps.length > 1) { s.sprints++; s.sprintPaid += Math.max(0, stepsDone - 1); }
    }
    if (detail) turnActions.push([round, act.id, act.kind === 'move' ? act.steps.length : act.kind === 'split' ? -act.split : 0, stepsDone]);
  };

  for (const e of rep.events) {
    switch (e.k) {
      case EV.ROUND:
        closeTurn(); act = null;
        if (round >= 0) endRound(round);
        round = e.round; inTurn = false; dropFrom = null;
        break;
      case EV.TURN:
        closeTurn();
        turn = e.id; act = null; stepsDone = 0; inTurn = true; dropFrom = null; headOnWith = -1;
        break;
      case EV.TILE: {
        const c = e.y * W + e.x;
        if (e.pearl) {
          if (inTurn && dropFrom) {
            pearlSrc[c] = dropFrom.team === 0 ? SRC.CORPSE_A : SRC.CORPSE_B;
            teams[dropFrom.team].dropped++;
          } else pearlSrc[c] = SRC.NATURAL;
          flow[pearlSrc[c] - 1][2]++;
          onBoard++;
        } else {
          let src = pearlSrc[c];
          if (!src) { check.unknownPearls++; src = SRC.NATURAL; }
          pearlSrc[c] = 0;
          onBoard--;
          const d = drag.get(turn);
          if (!d) break;
          const s = teams[d.team];
          s.eaten++; d.eaten++;
          flow[src - 1][d.team]++;
          if (src === SRC.NATURAL) s.eatenNatural++;
          else {
            const corpseTeam = src === SRC.CORPSE_A ? 0 : 1;
            if (corpseTeam === d.team) { s.eatenOwnCorpse++; teams[corpseTeam].droppedEatenByOwn++; }
            else { s.eatenEnemyCorpse++; teams[corpseTeam].droppedEatenByEnemy++; }
          }
          eats.push(round, c, d.team, src, d.id);
        }
        break;
      }
      case EV.ACTION: {
        act = e;
        const d = drag.get(e.id);
        if (!d) break;
        const s = teams[d.team];
        s.turns++;
        if (e.tle) s.tle++;
        if (e.instr != null) {
          s.measuredTurns++; s.instrSum += e.instr;
          if (e.instr > s.instrMax) s.instrMax = e.instr;
          if (e.exceeded) s.exceeded++;
          // Log-2 buckets from 2^8 instructions up.
          s.instrHist[Math.max(0, Math.min(23, Math.floor(Math.log2(Math.max(1, e.instr))) - 8))]++;
        }
        break;
      }
      case EV.UPDATE: {
        const d = drag.get(e.id);
        if (!d || round < 0) break; // before round 0 the engine just confirms the map's placement
        const head = e.hy * W + e.hx, tail = e.ty * W + e.tx;
        d.body.unshift(head);
        occ[head] = d.id;
        while (d.body.length > 1 && d.body[d.body.length - 1] !== tail) {
          const c = d.body.pop();
          if (occ[c] === d.id) occ[c] = -1;
        }
        d.steps++;
        teams[d.team].steps++;
        heat.head[d.team][head]++;
        if (d.body.length > d.maxLen) d.maxLen = d.body.length;
        if (e.id === turn) stepsDone++;
        break;
      }
      case EV.SPLIT: {
        const p = drag.get(e.parent);
        if (!p) break;
        const pb = e.parentBody.map(([x, y]) => y * W + x);
        const cb = e.childBody.map(([x, y]) => y * W + x);
        p.body = pb;
        for (const c of pb) occ[c] = p.id;
        addDragon(e.child, e.team, cb, p.id, Math.max(0, round));
        p.children++;
        const s = teams[e.team];
        s.splits++; s.splitSegments += cb.length; s.born++;
        splits.push(round, pb[0], e.team, cb.length, p.id, e.child);
        break;
      }
      case EV.DEATH: {
        const d = drag.get(e.id);
        if (!d) break;
        const len = d.body.length, headCell = d.body[0];
        let cause, killer = -1, where = headCell, dir = -1;
        if (e.reason === 3) {
          if (e.id !== turn) { killer = turn; headOnWith = e.id; }
          else killer = headOnWith;
          const k = drag.get(killer);
          cause = k && k.team === d.team ? 'allyHead' : 'enemyHead';
          if (killer === -1) check.unresolvedKills++;
        } else if (e.reason === 2) {
          dir = act && act.steps ? act.steps[stepsDone] ?? -1 : -1;
          const dest = dir >= 0 ? stepFrom(map, headCell, dir) : -1;
          killer = dest >= 0 ? occ[dest] : -1;
          if (dest >= 0) where = dest;
          const k = drag.get(killer);
          if (!k) check.unresolvedKills++;
          cause = k && k.team === d.team ? 'allyBody' : 'enemyBody';
        } else if (e.reason === 0) {
          cause = 'wall';
          dir = act && act.steps ? act.steps[stepsDone] ?? -1 : -1;
        } else if (e.reason === 1) {
          cause = 'self';
        } else if (!act || act.tle || act.kind === null) cause = 'timeout';
        else if (act.kind === 'split') cause = 'badSplit';
        else if (act.kind === 'move') cause = 'sprint';
        else cause = 'noMove';

        d.alive = false; d.died = Math.max(0, round); d.cause = cause; d.lenAtDeath = len;
        const s = teams[d.team];
        s.lost++; s.lostBy[cause]++; s.lenLostBy[cause] += len; s.lenLost += len;
        const k = drag.get(killer);
        let killerTeam = -1;
        if (k) {
          killerTeam = k.team;
          if (k.team !== d.team) {
            const ks = teams[k.team];
            ks.kills++; ks.killLen += len; k.kills++;
            if (cause === 'enemyBody') ks.bodyKills++; else ks.headKills++;
          }
        }
        if (!firstBlood) firstBlood = { round: d.died, team: d.team, cause, len };
        deaths.push({ r: d.died, id: d.id, team: d.team, cause, len, cell: where, head: headCell, killer, killerTeam,
          age: d.died - d.born, step: stepsDone, dir });
        for (const c of d.body) if (occ[c] === d.id) occ[c] = -1;
        dropFrom = d;
        break;
      }
      case EV.SONAR: {
        const d = drag.get(e.id);
        if (!d) break;
        const s = teams[d.team];
        s.pings++;
        s.pingKinds[e.kind < SONAR_KIND_COUNT ? e.kind : 0]++;
        if (detail && rays.length < 400000) rays.push(round, d.team, e.ox, e.oy, e.ex, e.ey, e.dir, e.kind);
        break;
      }
      case EV.ENGINE_LOG: case EV.DRAGON_LOG: case EV.INDICATOR: {
        const d = drag.get(e.id);
        if (d) { if (e.k === EV.ENGINE_LOG) teams[d.team].engineNotes++; else if (e.k === EV.DRAGON_LOG) teams[d.team].logs++; }
        if (detail && e.text != null && logs.length < 50000) logs.push({ r: round, id: e.id, team: d ? d.team : -1, k: e.k, text: e.text });
        break;
      }
      default: break;
    }
  }
  closeTurn();
  if (round >= 0) endRound(round);

  // Final standings, and a check against the engine's own result.
  const final = [[0, 0, 0], [0, 0, 0]];
  for (const d of dragons) if (d.alive) {
    const f = final[d.team];
    f[0]++; f[1] = Math.max(f[1], d.body.length); f[2] += d.body.length;
  }
  for (let t = 0; t < 2; t++) {
    teams[t].finalDragons = final[t][0]; teams[t].finalLongest = final[t][1]; teams[t].finalTotal = final[t][2];
  }
  const res = rep.result;
  if (res) {
    const want = [res.teamA, res.teamB];
    for (let t = 0; t < 2; t++) {
      if (want[t].dragonCount !== final[t][0] || want[t].longestDragon !== final[t][1] || want[t].totalLength !== final[t][2]) check.bodyMismatch++;
    }
  }

  // Who led on the engine's tiebreak (longest dragon, then total length) each round.
  const leader = [];
  let leadChanges = 0, lastLeader = 0, decisive = 0;
  for (let r = 0; r < tl.lenA.length; r++) {
    const a = [tl.longA[r], tl.lenA[r]], b = [tl.longB[r], tl.lenB[r]];
    const l = a[0] !== b[0] ? (a[0] > b[0] ? 1 : -1) : a[1] !== b[1] ? (a[1] > b[1] ? 1 : -1) : 0;
    leader.push(l);
    if (l !== 0 && l !== lastLeader) {
      if (lastLeader !== 0) leadChanges++;
      lastLeader = l;
      decisive = r;
    }
  }

  const winner = res?.winner ?? null;
  const out = {
    formatVersion: rep.formatVersion,
    botA: rep.botA, botB: rep.botB,
    map: { name: map.name || `${W}×${H}`, width: W, height: H, symmetry: map.symmetry, key: mapKey(map) },
    geometry: {
      width: W, height: H, symmetry: map.symmetry, hKind: map.hKind, vKind: map.vKind,
      beds: map.beds, bedMin: map.bedMin, bedMax: map.bedMax, portals: map.portalOf,
      spawns: map.dragons.map((d) => ({ team: d.team, body: d.body })),
    },
    rounds: tl.lenA.length,
    result: res,
    winner, endReason: res?.endReason ?? null,
    teams, flow, firstBlood,
    timeline: tl, leader, leadChanges, decisiveRound: decisive,
    deaths, eats: Int32Array.from(eats), splits: Int32Array.from(splits),
    heat, check,
    dragons: dragons.map((d) => ({ id: d.id, team: d.team, parent: d.parent, born: d.born, died: d.died, cause: d.cause,
      maxLen: d.maxLen, lenAtDeath: d.lenAtDeath, eaten: d.eaten, steps: d.steps, kills: d.kills, children: d.children,
      lens: d.lens ? Int16Array.from(d.lens) : null })),
  };
  if (detail) Object.assign(out, { mapData: map, snaps, logs, rays: Int32Array.from(rays), turnActions });
  return out;
}

/** Identifies a map by its geometry, so renamed copies still group together. */
function mapKey(m) {
  let h = 2166136261 >>> 0;
  const mix = (v) => { h ^= v; h = Math.imul(h, 16777619) >>> 0; };
  mix(m.width); mix(m.height);
  for (let i = 0; i < m.hKind.length; i++) { mix(m.hKind[i]); mix(m.vKind[i]); mix(m.beds[i]); }
  return `${m.name || 'map'}#${h.toString(36)}`;
}
