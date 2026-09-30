// Map library and editor: open .map files (or zips of them), look at them as
// charts, and edit them by dragging. Maps stay in this browser.
import { Board, scaleTop, rampCss } from './board.js';
import * as M from './mapmodel.js';
import { stepFrom } from './map.js';
import { loadAll, saveEntry, removeEntry, clearAll, zipTexts, download, slug } from './mapstore.js';
import { esc, fmt, pct } from './charts.js';

export const ED = {
  ready: null, maps: [], tool: 'kelp', presetId: 'r750', custom: { min: 1, max: 100 }, mirror: true, view: 'rate',
  history: new Map(),
};
let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
const SYM_LABEL = { none: 'no symmetry', x: 'mirrored top to bottom', y: 'mirrored left to right', xy: 'point symmetry' };

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------
export function libraryReady() {
  if (!ED.ready) {
    ED.ready = loadAll().then((rows) => {
      for (const r of rows) {
        try { ED.maps.push({ ...r, model: M.fromText(r.text, r.name) }); } catch { /* skip a corrupt entry */ }
      }
    });
  }
  return ED.ready;
}

function persist(entry) {
  entry.name = entry.model.name;
  entry.text = M.toText(entry.model);
  entry.updated = Date.now();
  const { model, ...row } = entry;
  saveEntry(row);
}
const persistSoon = (() => {
  const timers = new Map();
  return (entry) => { clearTimeout(timers.get(entry.id)); timers.set(entry.id, setTimeout(() => persist(entry), 400)); };
})();

function addEntry(model, origin, file = '') {
  const entry = { id: newId(), model, origin, file, order: Date.now() + ED.maps.length, updated: Date.now() };
  ED.maps.push(entry);
  persist(entry);
  return entry;
}

/** Add maps from intake sources ({ name, path, read() }). Returns { added, duplicates, errors }. */
export async function addMapSources(sources) {
  await libraryReady();
  const known = new Set(ED.maps.map((e) => e.text));
  const out = { added: [], duplicates: 0, errors: [] };
  const dec = new TextDecoder();
  for (const src of sources) {
    try {
      const text = dec.decode(await src.read());
      const model = M.fromText(text, src.name.replace(/\.map$/i, ''));
      const canon = M.toText(model);
      if (known.has(canon)) { out.duplicates++; continue; }
      known.add(canon);
      out.added.push(addEntry(model, 'file', src.path));
    } catch (err) {
      out.errors.push({ name: src.path, error: /no map/i.test(err.message) ? 'Not a map file: it has no MAP line' : err.message });
    }
  }
  return out;
}

/** Open a map seen in replays in the editor. */
export async function addFromGeometry(geom, name) {
  await libraryReady();
  const model = M.fromGeometry(geom, name);
  const canon = M.toText(model);
  const existing = ED.maps.find((e) => e.text === canon);
  return existing || addEntry(model, 'replay');
}

// ---------------------------------------------------------------------------
// thumbnails
// ---------------------------------------------------------------------------
function drawThumb(canvas, m) {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const W = m.width, H = m.height;
  const s = Math.max(1, Math.floor(Math.min(220 / W, 150 / H)));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * s * dpr; canvas.height = H * s * dpr;
  canvas.style.width = `${W * s}px`; canvas.style.height = `${H * s}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = v('--chart-water');
  ctx.fillRect(0, 0, W * s, H * s);
  const rate = new Float32Array(W * H);
  for (let c = 0; c < rate.length; c++) rate[c] = M.bedRate(m, c);
  const top = scaleTop(rate);
  const ramp = rampCss('neutral', isDark(), 12);
  for (let c = 0; c < rate.length; c++) {
    if (!rate[c]) continue;
    ctx.fillStyle = ramp[Math.min(11, Math.floor(Math.sqrt(Math.min(1, rate[c] / top)) * 11))];
    ctx.fillRect((c % W) * s, Math.floor(c / W) * s, s, s);
  }
  ctx.lineWidth = Math.max(1, s * 0.35);
  ctx.lineCap = 'round';
  for (const [kinds, h] of [[m.hKind, true], [m.vKind, false]]) {
    for (let c = 0; c < kinds.length; c++) {
      if (!kinds[c]) continue;
      const x = (c % W) * s, y = Math.floor(c / W) * s;
      ctx.strokeStyle = kinds[c] === M.EDGE_KELP ? v('--kelp') : v('--portal');
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(h ? x + s : x, h ? y : y + s); ctx.stroke();
    }
  }
  for (const d of m.dragons) {
    ctx.fillStyle = d.team === 0 ? v('--you') : v('--opp');
    for (const c of d.body) ctx.fillRect((c % W) * s, Math.floor(c / W) * s, s, s);
  }
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
/** #/editor (library) or #/editor/<id> (workspace). */
export function viewEditor(main, arg, hooks) {
  let alive = true, cleanup = () => {};
  main.innerHTML = '<p class="muted">Opening your maps…</p>';
  libraryReady().then(() => {
    if (!alive) return;
    const entry = arg && ED.maps.find((e) => e.id === arg);
    if (entry) cleanup = workspace(main, entry, hooks);
    else library(main, hooks);
  });
  return { soft: false, cleanup: () => { alive = false; cleanup(); } };
}

function library(main, hooks) {
  const maps = ED.maps;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="headline">Map editor</h1>
        <p class="subline">Drop <b>.map</b> files, a folder or a <b>.zip</b> anywhere on this page, or start a new map. Maps and your edits stay in this browser.</p>
      </div>
      <div class="ed-lib-actions">
        <button class="btn primary" id="lib-new" type="button">New map</button>
        <button class="btn" id="lib-open" type="button">Open files</button>
        ${maps.length ? '<button class="btn" id="lib-zip" type="button">Download all as .zip</button><button class="btn" id="lib-clear" type="button">Remove all</button>' : ''}
      </div>
    </div>
    <form class="ed-new" id="new-form" hidden>
      <label>Name <input name="name" value="Untitled" required maxlength="60"></label>
      <label>Width <input name="w" type="number" min="7" max="256" value="32" required></label>
      <label>Height <input name="h" type="number" min="7" max="256" value="24" required></label>
      <label>Symmetry <select name="sym"><option value="xy">Point (rotated)</option><option value="y">Left to right</option><option value="x">Top to bottom</option><option value="none">None</option></select></label>
      <label>Pearl beds <select name="bed">${M.BED_PRESETS.map((p) => `<option value="${p.id}" ${p.id === 'r750' ? 'selected' : ''}>${p.id === 'none' ? 'None' : `Everywhere, ${p.label}`}</option>`).join('')}</select></label>
      <button class="btn primary" type="submit">Create</button>
    </form>
    ${maps.length ? `<p class="muted" style="margin-bottom:14px">${maps.length} ${maps.length === 1 ? 'map' : 'maps'}</p>
      <div class="ed-grid">${maps.map((e) => {
        const v = M.validate(e.model);
        const status = v.errors.length ? `<span class="ed-bad">${v.errors.length} ${v.errors.length === 1 ? 'problem' : 'problems'}</span>` : v.warnings.length ? `<span class="ed-warn">${v.warnings.length} ${v.warnings.length === 1 ? 'warning' : 'warnings'}</span>` : '<span class="ed-ok">Ready</span>';
        return `<a class="ed-card" href="#/editor/${e.id}"><canvas data-id="${e.id}"></canvas><span class="chart-name">${esc(e.model.name)}</span><span class="muted">${e.model.width} × ${e.model.height}, ${SYM_LABEL[e.model.symmetry]}</span>${status}</a>`;
      }).join('')}</div>`
      : `<div class="empty"><h2>No maps yet</h2><p style="margin-top:8px">Drop some .map files here, or make one from scratch. Maps you open from the Maps view of your replays also land here.</p></div>`}`;
  for (const cv of $$('canvas[data-id]', main)) drawThumb(cv, maps.find((e) => e.id === cv.dataset.id).model);
  $('#lib-open').onclick = () => $('#pick-files').click();
  $('#lib-new').onclick = () => { const f = $('#new-form'); f.hidden = !f.hidden; if (!f.hidden) f.name.select(); };
  $('#new-form').onsubmit = (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const preset = M.BED_PRESETS.find((p) => p.id === f.bed.value);
    const w = Math.max(7, Math.min(256, Number(f.w.value) || 32)), h = Math.max(7, Math.min(256, Number(f.h.value) || 24));
    const entry = addEntry(M.blankModel({ width: w, height: h, symmetry: f.sym.value, name: f.name.value.trim() || 'Untitled', bed: preset.max ? preset : null }), 'new');
    location.hash = `#/editor/${entry.id}`;
  };
  const zipBtn = $('#lib-zip');
  if (zipBtn) zipBtn.onclick = () => {
    const used = new Map();
    const files = maps.map((e) => {
      let name = slug(e.model.name);
      const n = used.get(name) || 0; used.set(name, n + 1);
      if (n) name += `-${n + 1}`;
      return { name: `maps/${name}.map`, text: M.toText(e.model) };
    });
    download(zipTexts(files), 'soundings-maps.zip');
  };
  const clearBtn = $('#lib-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm(`Remove all ${maps.length} maps from this browser? Download them first if you want to keep your edits.`)) return;
    await clearAll();
    ED.maps.length = 0;
    library(main, hooks);
  };
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------
const TOOLS = [
  { id: 'move', key: 'v', label: 'Move', hint: 'Drag a dragon to move it. Its mirror twin follows when mirroring is on.' },
  { id: 'kelp', key: 'k', label: 'Kelp', hint: 'Drag along cell edges to draw kelp. Start a drag on existing kelp to erase instead.' },
  { id: 'bed', key: 'b', label: 'Beds', hint: 'Drag to paint beds with the chosen spawn gap. Shift-click fills a region enclosed by kelp.' },
  { id: 'portal', key: 'p', label: 'Portal', hint: 'Click an edge, then another edge running the same way, to join them. Click a portal to remove its pair. Esc cancels.' },
  { id: 'dragonA', key: 'a', label: 'Dragon A', hint: 'Drag from the head along the body. Backtrack to shorten it. Needs at least 2 cells.' },
  { id: 'dragonB', key: 'd', label: 'Dragon B', hint: 'Drag from the head along the body. Backtrack to shorten it. Needs at least 2 cells.' },
  { id: 'erase', key: 'e', label: 'Erase', hint: 'Drag over kelp, portals or dragons to remove them. Paint beds with "No bed" to clear beds.' },
];

function workspace(main, entry, hooks) {
  let m = entry.model;
  const hist = ED.history.get(entry.id) || { undo: [], redo: [] };
  ED.history.set(entry.id, hist);
  let info = M.analyse(m), checks = M.validate(m);
  let hover = null;        // { edge, dist, cell }
  let drag = null;         // stroke state
  let pending = null;      // first portal end

  main.innerHTML = `
    <div class="ed-head">
      <a class="back" href="#/editor">All maps</a>
      <input class="ed-name chart-name" id="ed-name" value="${esc(m.name)}" aria-label="Map name" maxlength="60">
      <span class="muted" id="ed-dims"></span>
      <span class="spacer"></span>
      <button class="btn" id="ed-copy" type="button">Duplicate</button>
      <button class="btn" id="ed-delete" type="button">Delete</button>
      <button class="btn primary" id="ed-dl" type="button">Download .map</button>
    </div>
    <div class="ed-tools" role="toolbar" aria-label="Tools">
      <div class="seg-ctl" id="ed-tool">${TOOLS.map((t) => `<button type="button" data-tool="${t.id}" title="${esc(t.label)} (${t.key.toUpperCase()})">${esc(t.label)}</button>`).join('')}</div>
      <span id="ed-bedopts" class="ed-bedopts">
        <select class="plain" id="ed-preset" aria-label="Spawn gap">${M.BED_PRESETS.map((p) => `<option value="${p.id}">${p.id === 'none' ? 'No bed' : p.id === 'r1' ? 'Every round' : `Every ${p.label}`}</option>`).join('')}<option value="custom">Custom gap…</option></select>
        <span id="ed-custom" hidden><input type="number" id="ed-min" min="0" max="65535" aria-label="Minimum gap"> to <input type="number" id="ed-max" min="1" max="65535" aria-label="Maximum gap"> rounds</span>
      </span>
      <label class="check" title="Mirror every edit across the map's symmetry (M)"><input type="checkbox" id="ed-mirror"> Mirror edits</label>
      <span class="spacer"></span>
      <button class="btn" id="ed-undo" type="button" title="Undo (⌘Z)">Undo</button>
      <button class="btn" id="ed-redo" type="button" title="Redo (⇧⌘Z)">Redo</button>
    </div>
    <div class="ed-work">
      <div><div id="ed-board"></div><p class="muted ed-hint" id="ed-hint"></p></div>
      <aside class="ed-side">
        <div class="seg-ctl" id="ed-view" role="group" aria-label="Shading">
          <button type="button" data-view="rate">Spawn rate</button><button type="button" data-view="closer">Who's closer</button><button type="button" data-view="plain">Plain</button>
        </div>
        <div id="ed-legend"></div>
        <div id="ed-cell" class="muted">Point at the map for details.</div>
        <div id="ed-stats"></div>
        <div id="ed-checks"></div>
        <details class="ed-props">
          <summary>Size, symmetry and limits</summary>
          <div class="ed-form">
            <label>Width <input type="number" id="ed-w" min="7" max="256"></label>
            <label>Height <input type="number" id="ed-h" min="7" max="256"></label>
            <label>Symmetry <select id="ed-sym"><option value="xy">Point (rotated)</option><option value="y">Left to right</option><option value="x">Top to bottom</option><option value="none">None</option></select></label>
            <label>Unit limit <input type="number" id="ed-units" min="1" max="1000"></label>
            <button class="btn" id="ed-apply" type="button">Apply</button>
          </div>
          <p class="muted" style="font-size:13px;margin-top:8px">Resizing keeps the top-left corner; dragons that no longer fit are removed.</p>
          <button class="btn" id="ed-sym-copy" type="button" style="margin-top:8px"></button>
        </details>
      </aside>
    </div>`;

  const board = new Board($('#ed-board'), M.geometryOf(m), {
    maxHeight: Math.max(460, innerHeight - 190),
    label: `Editable chart of ${m.name}; the panel beside it lists the numbers and any problems`,
    onHover: () => {},
  });
  board.spawnStyle = 'solid';
  board.hoverCell = false;
  const cv = board.canvas;
  cv.classList.add('ed-canvas');

  // ---- helpers -----------------------------------------------------------------------
  const W = () => m.width, H = () => m.height;
  const mirrorOn = () => ED.mirror && m.symmetry !== 'none';
  const edgeKey = (e) => `${e.o}${e.c}`;
  const sameEdge = (a, b) => a && b && a.o === b.o && a.c === b.c;
  const withMirrorEdges = (e) => { const out = [e]; if (mirrorOn()) { const t = M.mirrorEdge(m, e); if (!sameEdge(t, e)) out.push(t); } return out; };
  const withMirrorCells = (c) => { const out = [c]; if (mirrorOn()) { const t = M.mirrorCell(m, c); if (t !== c) out.push(t); } return out; };
  const preset = () => (ED.presetId === 'custom' ? { min: ED.custom.min, max: ED.custom.max } : M.BED_PRESETS.find((p) => p.id === ED.presetId));

  /** The nearest edge running one way ('h' or 'v'): strokes stay on the line they're drawing. */
  function nearestEdgeOriented(p, o) {
    const w = W(), h = H();
    if (o === 'h') {
      const top = p.fy - p.y < 0.5;
      return { edge: { o: 'h', c: (top ? p.y : (p.y + 1) % h) * w + p.x }, dist: top ? p.fy - p.y : 1 - (p.fy - p.y) };
    }
    const left = p.fx - p.x < 0.5;
    return { edge: { o: 'v', c: p.y * w + (left ? p.x : (p.x + 1) % w) }, dist: left ? p.fx - p.x : 1 - (p.fx - p.x) };
  }
  /** Which way a stroke segment runs: sideways strokes draw horizontal edges, up-down strokes vertical ones. */
  const strokeOrient = (a, b) => (Math.abs(b.fx - a.fx) >= Math.abs(b.fy - a.fy) ? 'h' : 'v');

  function nearestEdge(p) {
    const dx = p.fx - p.x, dy = p.fy - p.y;
    const sides = [['top', dy], ['bottom', 1 - dy], ['left', dx], ['right', 1 - dx]].sort((a, b) => a[1] - b[1]);
    const [side, dist] = sides[0];
    const w = W(), h = H();
    const edge = side === 'top' ? { o: 'h', c: p.y * w + p.x } : side === 'bottom' ? { o: 'h', c: ((p.y + 1) % h) * w + p.x }
      : side === 'left' ? { o: 'v', c: p.y * w + p.x } : { o: 'v', c: p.y * w + (p.x + 1) % w };
    return { edge, dist };
  }
  /** The edge between two grid-adjacent cells, or null. */
  function edgeBetween(a, b) {
    const w = W(), h = H(), ax = a % w, ay = (a - ax) / w, bx = b % w, by = (b - bx) / w;
    if (ay === by && (bx === (ax + 1) % w)) return { o: 'v', c: b };
    if (ay === by && (ax === (bx + 1) % w)) return { o: 'v', c: a };
    if (ax === bx && (by === (ay + 1) % h)) return { o: 'h', c: b };
    if (ax === bx && (ay === (by + 1) % h)) return { o: 'h', c: a };
    return null;
  }
  function neighbour(c, dir) {
    const w = W(), h = H(), x = c % w, y = (c - x) / w;
    return dir === 0 ? ((y - 1 + h) % h) * w + x : dir === 2 ? ((y + 1) % h) * w + x : dir === 3 ? y * w + (x - 1 + w) % w : y * w + (x + 1) % w;
  }
  function bodyValid(body, ignore = []) {
    if (body.length < 2 || new Set(body).size !== body.length) return false;
    const others = new Set();
    for (const d of m.dragons) if (!ignore.includes(d)) for (const c of d.body) others.add(c);
    if (body.some((c) => others.has(c))) return false;
    const wm = M.walkable(m);
    for (let k = 1; k < body.length; k++) {
      let ok = false;
      for (let dir = 0; dir < 4; dir++) if (stepFrom(wm, body[k], dir) === body[k - 1]) ok = true;
      if (!ok) return false;
    }
    return true;
  }
  const twinOf = (d) => {
    if (m.symmetry === 'none') return null;
    const t = M.mirrorDragon(m, d);
    return m.dragons.find((o) => o !== d && o.team === t.team && o.body.length === t.body.length && o.body.every((c, i) => c === t.body[i])) || null;
  };

  // ---- history ----------------------------------------------------------------------------
  function checkpoint() { hist.undo.push(M.clone(m)); if (hist.undo.length > 200) hist.undo.shift(); hist.redo.length = 0; }
  function replaceModel(next) { entry.model = m = next; changed(true); }
  function undo() { if (!hist.undo.length) return; hist.redo.push(M.clone(m)); replaceModel(hist.undo.pop()); }
  function redo() { if (!hist.redo.length) return; hist.undo.push(M.clone(m)); replaceModel(hist.redo.pop()); }

  // ---- redraw ---------------------------------------------------------------------------------
  // Redraw on the next frame; background tabs get no frames, so fall back to a
  // timer there, or edits made while hidden wouldn't show or save.
  let frame = 0;
  const later = (fn) => (document.hidden ? -setTimeout(fn, 16) : requestAnimationFrame(fn));
  const cancelLater = (h) => (h < 0 ? clearTimeout(-h) : cancelAnimationFrame(h));
  function changed(structural = false) {
    if (frame) return;
    frame = later(() => {
      frame = 0;
      info = M.analyse(m);
      checks = M.validate(m);
      board.geom = M.geometryOf(m);
      applyView();
      renderSide();
      if (structural) syncControls();
      persistSoon(entry);
    });
  }
  function applyView() {
    if (ED.view === 'rate') { board.layer = { values: info.rate, kind: 'neutral' }; board.bedRings = false; }
    else if (ED.view === 'closer') { board.layer = { values: info.closer, weight: info.rate.map((r) => r || 0.5), kind: 'share' }; board.bedRings = false; }
    else { board.layer = null; board.bedRings = true; }
    board.draw();
  }

  board.decorate = (ctx, f) => {
    const { X, Y, s, v } = f;
    const edgeLine = (e, color, width, dash) => {
      const x = e.c % W(), y = (e.c - x) / W();
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(X(x), Y(y)); ctx.lineTo(e.o === 'h' ? X(x + 1) : X(x), e.o === 'h' ? Y(y) : Y(y + 1)); ctx.stroke();
      ctx.restore();
    };
    const cellBox = (c, color, dash) => {
      const x = c % W(), y = (c - x) / W();
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2; if (dash) ctx.setLineDash(dash);
      ctx.strokeRect(X(x) + 1, Y(y) + 1, s - 2, s - 2); ctx.restore();
    };
    const body = (cells, color, alpha = 0.85) => {
      ctx.save(); ctx.globalAlpha = alpha;
      board.strokeBody(cells, color, Math.max(2, s * 0.5), X, Y, s, W());
      ctx.restore();
    };
    const accent = v('--accent');
    if (pending) edgeLine(pending, accent, Math.max(3, s * 0.3));
    if (drag?.path) {
      const ok = drag.path.length >= 2;
      body(drag.path, drag.team === 0 ? v('--you') : v('--opp'), ok ? 0.75 : 0.45);
      if (mirrorOn() && ok) body(drag.path.map((c) => M.mirrorCell(m, c)), drag.team === 0 ? v('--opp') : v('--you'), 0.35);
    }
    if (drag?.moved) {
      const color = drag.valid ? accent : v('--loss');
      body(drag.moved, color, 0.8);
      if (drag.movedTwin) body(drag.movedTwin, color, 0.45);
    }
    if (!drag && hover) {
      if (['kelp', 'erase', 'portal'].includes(ED.tool) && hover.edge) {
        for (const [i, e] of withMirrorEdges(hover.edge).entries()) edgeLine(e, accent, Math.max(2, s * 0.2), i ? [4, 4] : null);
      } else if (ED.tool === 'bed' && hover.cell != null) {
        for (const [i, c] of withMirrorCells(hover.cell).entries()) cellBox(c, accent, i ? [4, 4] : null);
      } else if ((ED.tool === 'dragonA' || ED.tool === 'dragonB') && hover.cell != null) {
        cellBox(hover.cell, ED.tool === 'dragonA' ? v('--you') : v('--opp'));
      } else if (ED.tool === 'move' && hover.cell != null) {
        const d = M.dragonAt(m, hover.cell);
        if (d) body(d.body, accent, 0.5);
      }
    }
  };

  // ---- side panel --------------------------------------------------------------------------------
  function renderSide() {
    $('#ed-dims').textContent = `${m.width} × ${m.height}, ${SYM_LABEL[m.symmetry]}`;
    const legend = $('#ed-legend');
    if (ED.view === 'rate') {
      const top = scaleTop(info.rate);
      legend.innerHTML = `<div class="ramp">${rampCss('neutral', isDark(), 10).map((c) => `<div style="background:${c}"></div>`).join('')}</div><div class="ramp-labels"><span>No bed</span><span>${fmt(top, top < 10 ? 1 : 0)}+ pearls per 100 rounds</span></div>`;
    } else if (ED.view === 'closer') {
      legend.innerHTML = `<div class="ramp">${rampCss('opp', isDark(), 5).reverse().map((c) => `<div style="background:${c}"></div>`).join('')}<div style="background:var(--chart-even)"></div>${rampCss('you', isDark(), 5).map((c) => `<div style="background:${c}"></div>`).join('')}</div><div class="ramp-labels"><span>Team B gets there first</span><span>Tie</span><span>Team A first</span></div><p class="muted" style="font-size:12.5px;margin-top:4px">Shortest path from each team's nearest starting head, around kelp and through portals. Stronger shading means more pearls.</p>`;
    } else legend.innerHTML = '';
    const [a, b] = info.dragons;
    const len = (list) => list.reduce((sum, d) => sum + d.body.length, 0);
    const share = (x) => pct(x / Math.max(1e-9, info.reachable), 1);
    $('#ed-stats').innerHTML = `
      <dl class="ed-dl">
        <dt>Pearl beds</dt><dd>${fmt(info.beds)} <span class="muted">of ${fmt(info.cells)} cells</span></dd>
        <dt>Pearls per 100 rounds</dt><dd>${fmt(info.pearlsPer100, 0)}</dd>
        <dt>Kelp edges</dt><dd>${fmt(info.kelp)}</dd>
        <dt>Portal pairs</dt><dd>${fmt(info.portals)}</dd>
        <dt><span class="you-ink">Team A</span></dt><dd>${a.length} ${a.length === 1 ? 'dragon' : 'dragons'}, length ${len(a)}</dd>
        <dt><span class="opp-ink">Team B</span></dt><dd>${b.length} ${b.length === 1 ? 'dragon' : 'dragons'}, length ${len(b)}</dd>
      </dl>
      <h3 style="margin-top:14px">Who reaches the pearls first</h3>
      <div class="splitbar" style="margin-top:8px">${[['you', info.toA], ['even', info.tied], ['opp', info.toB]].filter(([, x]) => x > 0).map(([k, x]) => `<div class="seg" style="flex:${x};background:var(--${k === 'even' ? 'chart-even' : k})"></div>`).join('')}</div>
      <div class="splitbar-legend"><span>Team A <b>${share(info.toA)}</b></span><span>Tied <b>${share(info.tied)}</b></span><span>Team B <b>${share(info.toB)}</b></span></div>
      ${info.unreachable > 0 ? `<p class="ed-warn" style="margin-top:6px">${fmt(info.unreachable, 0)} pearls per 100 rounds spawn where no dragon can reach.</p>` : ''}`;
    const list = [...checks.errors.map((t) => ['bad', t]), ...checks.warnings.map((t) => ['warn', t])];
    $('#ed-checks').innerHTML = `<h3>Checks</h3>${list.length ? `<ul class="ed-list">${list.map(([k, t]) => `<li class="ed-${k}">${esc(t)}</li>`).join('')}</ul>` : '<p class="ed-ok">The engine will load this map, and both sides start evenly.</p>'}`;
    $('#ed-undo').disabled = !hist.undo.length;
    $('#ed-redo').disabled = !hist.redo.length;
  }
  function cellInfo(p) {
    const box = $('#ed-cell');
    if (!p) { box.className = 'muted'; box.textContent = 'Point at the map for details.'; return; }
    const c = p.cell, rows = [];
    rows.push(['Cell', `${p.x}, ${p.y}`]);
    rows.push(['Pearl bed', m.beds[c] ? `every ${m.bedMin[c]}–${m.bedMax[c]} rounds` : 'none']);
    const da = info.distA[c], db = info.distB[c];
    rows.push(['Steps from A', da < 0 ? 'unreachable' : fmt(da)], ['Steps from B', db < 0 ? 'unreachable' : fmt(db)]);
    const d = M.dragonAt(m, c);
    if (d) rows.push(['Dragon', `${d.team === 0 ? 'Team A' : 'Team B'}, length ${d.body.length}${d.body[0] === c ? ', head' : ''}`]);
    box.className = '';
    box.innerHTML = `<dl class="ed-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }

  // ---- controls ---------------------------------------------------------------------------------
  function syncControls() {
    $$('#ed-tool button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === ED.tool)));
    $$('#ed-view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === ED.view)));
    $('#ed-bedopts').style.visibility = ED.tool === 'bed' ? 'visible' : 'hidden';
    $('#ed-preset').value = ED.presetId;
    $('#ed-custom').hidden = ED.presetId !== 'custom';
    $('#ed-min').value = ED.custom.min; $('#ed-max').value = ED.custom.max;
    $('#ed-mirror').checked = ED.mirror;
    $('#ed-mirror').disabled = m.symmetry === 'none';
    $('#ed-hint').textContent = TOOLS.find((t) => t.id === ED.tool).hint + (m.symmetry === 'none' ? '' : ED.mirror ? ' Edits are mirrored.' : '');
    $('#ed-name').value = m.name;
    $('#ed-w').value = m.width; $('#ed-h').value = m.height; $('#ed-sym').value = m.symmetry; $('#ed-units').value = m.unitLimit;
    const half = M.sourceHalf(m);
    const symBtn = $('#ed-sym-copy');
    symBtn.hidden = !half;
    if (half) symBtn.textContent = `Copy the ${half}`;
    cv.dataset.tool = ED.tool;
  }
  const setTool = (id) => { ED.tool = id; pending = null; syncControls(); board.draw(); };
  $$('#ed-tool button').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  $$('#ed-view button').forEach((b) => { b.onclick = () => { ED.view = b.dataset.view; syncControls(); applyView(); renderSide(); }; });
  $('#ed-preset').onchange = (e) => { ED.presetId = e.target.value; syncControls(); };
  $('#ed-min').onchange = (e) => { ED.custom.min = Math.max(0, Number(e.target.value) || 0); };
  $('#ed-max').onchange = (e) => { ED.custom.max = Math.max(1, Number(e.target.value) || 1); };
  $('#ed-mirror').onchange = (e) => { ED.mirror = e.target.checked; syncControls(); };
  $('#ed-undo').onclick = undo;
  $('#ed-redo').onclick = redo;
  $('#ed-name').onchange = (e) => { checkpoint(); m.name = e.target.value.trim() || 'Untitled'; changed(); };
  $('#ed-apply').onclick = () => {
    const w = Math.max(7, Math.min(256, Number($('#ed-w').value) || m.width));
    const h = Math.max(7, Math.min(256, Number($('#ed-h').value) || m.height));
    checkpoint();
    let next = (w !== m.width || h !== m.height) ? M.resize(m, w, h) : M.clone(m);
    next.symmetry = $('#ed-sym').value;
    next.unitLimit = Math.max(1, Number($('#ed-units').value) || 64);
    if (w !== m.width || h !== m.height) { board.geom = M.geometryOf(next); }
    replaceModel(next);
  };
  $('#ed-sym-copy').onclick = () => { checkpoint(); replaceModel(M.symmetrize(m)); };
  $('#ed-dl').onclick = () => download(new Blob([M.toText(m)], { type: 'text/plain' }), `${slug(m.name)}.map`);
  $('#ed-copy').onclick = () => {
    const copy = M.clone(m);
    copy.name = `${m.name} copy`;
    const e2 = addEntry(copy, 'copy');
    location.hash = `#/editor/${e2.id}`;
  };
  $('#ed-delete').onclick = async () => {
    if (!confirm(`Delete "${m.name}" from this browser? Download it first if you want to keep it.`)) return;
    await removeEntry(entry.id);
    ED.maps.splice(ED.maps.indexOf(entry), 1);
    location.hash = '#/editor';
  };

  // ---- pointer ------------------------------------------------------------------------------------
  function applyKelp(e, mode) {
    for (const t of withMirrorEdges(e)) {
      const k = M.edgeKind(m, t);
      if (mode === 'add' && k === M.EDGE_EMPTY) M.setEdge(m, t, M.EDGE_KELP);
      if (mode === 'remove' && k === M.EDGE_KELP) M.setEdge(m, t, M.EDGE_EMPTY);
    }
  }
  function paintBed(c) {
    const p = preset();
    for (const t of withMirrorCells(c)) {
      m.beds[t] = p.max > 0 ? 1 : 0;
      m.bedMin[t] = p.max > 0 ? Math.min(p.min, p.max) : 0;
      m.bedMax[t] = p.max > 0 ? p.max : 0;
    }
  }
  function fillRegion(start) {
    const w = W(), h = H(), seen = new Uint8Array(w * h), cells = [start];
    seen[start] = 1;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i], x = c % w, y = (c - x) / w;
      const exits = [[m.hKind[c], ((y - 1 + h) % h) * w + x], [m.hKind[((y + 1) % h) * w + x], ((y + 1) % h) * w + x],
        [m.vKind[c], y * w + (x - 1 + w) % w], [m.vKind[y * w + (x + 1) % w], y * w + (x + 1) % w]];
      for (const [k, n] of exits) if (!k && !seen[n]) { seen[n] = 1; cells.push(n); }
    }
    for (const c of cells) paintBed(c);
    return cells.length;
  }
  function removePortal(e) {
    const id = M.edgePortal(m, e);
    const pair = M.portalPairs(m).pairs.find((p) => p.id === id);
    const ends = pair ? [{ o: pair.orient, c: pair.a }, { o: pair.orient, c: pair.b }] : [e];
    for (const end of ends) for (const t of withMirrorEdges(end)) if (M.edgeKind(m, t) === M.EDGE_PORTAL) {
      const tid = M.edgePortal(m, t);
      for (const q of M.portalPairs(m).pairs.filter((p) => p.id === tid)) { M.setEdge(m, { o: q.orient, c: q.a }, M.EDGE_EMPTY); M.setEdge(m, { o: q.orient, c: q.b }, M.EDGE_EMPTY); }
      M.setEdge(m, t, M.EDGE_EMPTY);
    }
  }
  function addPortal(a, b) {
    let id = M.nextPortalId(m);
    M.setEdge(m, a, M.EDGE_PORTAL, id); M.setEdge(m, b, M.EDGE_PORTAL, id);
    if (mirrorOn()) {
      const ma = M.mirrorEdge(m, a), mb = M.mirrorEdge(m, b);
      const self = (sameEdge(ma, a) && sameEdge(mb, b)) || (sameEdge(ma, b) && sameEdge(mb, a));
      if (!self && M.edgeKind(m, ma) !== M.EDGE_PORTAL && M.edgeKind(m, mb) !== M.EDGE_PORTAL && !sameEdge(ma, mb)) {
        id++;
        M.setEdge(m, ma, M.EDGE_PORTAL, id); M.setEdge(m, mb, M.EDGE_PORTAL, id);
      }
    }
  }
  function removeDragon(d) {
    const twin = mirrorOn() ? twinOf(d) : null;
    m.dragons = m.dragons.filter((o) => o !== d && o !== twin);
  }
  function extendPath(target) {
    const path = drag.path;
    for (let guard = 0; guard < 400 && path[path.length - 1] !== target; guard++) {
      const last = path[path.length - 1], w = W();
      const lx = last % w, ly = (last - lx) / w, tx = target % w, ty = (target - tx) / w;
      const dx = tx - lx, dy = ty - ly;
      const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      const n = neighbour(last, dir);
      if (path.length >= 2 && n === path[path.length - 2]) { path.pop(); continue; }
      const between = edgeBetween(last, n);
      if (path.includes(n) || M.dragonAt(m, n) || !between || M.edgeKind(m, between) !== M.EDGE_EMPTY) break;
      path.push(n);
    }
  }
  function shifted(body, dx, dy) {
    const w = W(), h = H();
    return body.map((c) => { const x = c % w, y = (c - x) / w; return ((y + dy) % h + h) % h * w + ((x + dx) % w + w) % w; });
  }

  function down(ev) {
    if (ev.button !== 0) return;
    const p = board.pointer(ev);
    if (!p) return;
    ev.preventDefault();
    try { cv.setPointerCapture(ev.pointerId); } catch { /* not an active pointer (synthetic events): carry on without capture */ }
    const tool = ED.tool;
    if (tool === 'kelp') {
      const { edge } = nearestEdge(p);
      const k = M.edgeKind(m, edge);
      if (k === M.EDGE_PORTAL) return;
      checkpoint();
      drag = { tool, mode: k === M.EDGE_KELP ? 'remove' : 'add', seen: new Set([edgeKey(edge)]), lastP: p };
      applyKelp(edge, drag.mode);
      changed();
    } else if (tool === 'bed') {
      checkpoint();
      if (ev.shiftKey) { fillRegion(p.cell); changed(); return; }
      drag = { tool, last: p.cell };
      paintBed(p.cell);
      changed();
    } else if (tool === 'portal') {
      const { edge } = nearestEdge(p);
      if (M.edgeKind(m, edge) === M.EDGE_PORTAL) { checkpoint(); removePortal(edge); pending = null; changed(); return; }
      if (!pending) { pending = edge; board.draw(); return; }
      if (sameEdge(pending, edge)) { pending = null; board.draw(); return; }
      if (pending.o !== edge.o) { flashHint('A portal joins two edges that run the same way. Pick another edge.'); return; }
      checkpoint();
      addPortal(pending, edge);
      pending = null;
      changed();
    } else if (tool === 'dragonA' || tool === 'dragonB') {
      if (M.dragonAt(m, p.cell)) { flashHint('That cell already has a dragon. Use Move to drag it, or Erase to remove it.'); return; }
      drag = { tool, team: tool === 'dragonA' ? 0 : 1, path: [p.cell] };
      board.draw();
    } else if (tool === 'move') {
      const d = M.dragonAt(m, p.cell);
      if (!d) return;
      drag = { tool, dragon: d, twin: mirrorOn() ? twinOf(d) : null, from: p, moved: d.body, valid: true };
    } else if (tool === 'erase') {
      checkpoint();
      drag = { tool, touched: false, lastP: p };
      eraseAt(p);
    }
  }
  function eraseAt(p, orient = null) {
    const d = M.dragonAt(m, p.cell);
    if (d) { removeDragon(d); drag.touched = true; changed(); return; }
    const { edge, dist } = orient ? nearestEdgeOriented(p, orient) : nearestEdge(p);
    if (dist > 0.3) return;
    const k = M.edgeKind(m, edge);
    if (k === M.EDGE_PORTAL) { removePortal(edge); drag.touched = true; changed(); }
    else if (k === M.EDGE_KELP) { applyKelp(edge, 'remove'); drag.touched = true; changed(); }
  }
  function move(ev) {
    const p = board.pointer(ev);
    if (!drag) {
      const next = p ? { cell: p.cell, ...nearestEdge(p) } : null;
      const key = next ? `${next.cell}|${next.edge.o}${next.edge.c}` : '';
      if (key !== hover?.key) { hover = next && { ...next, key }; board.draw(); }
      cellInfo(p);
      return;
    }
    if (!p) return;
    if (drag.tool === 'kelp') {
      // Sample the stroke every quarter cell so a fast drag doesn't skip edges,
      // and keep to the edges running the way the stroke goes, so passing a
      // cell corner doesn't also wall off the perpendicular edge.
      const o = strokeOrient(drag.lastP, p);
      for (const q of along(drag.lastP, p)) {
        const { edge } = nearestEdgeOriented(q, o);
        if (!drag.seen.has(edgeKey(edge))) { drag.seen.add(edgeKey(edge)); applyKelp(edge, drag.mode); changed(); }
      }
      drag.lastP = p;
    } else if (drag.tool === 'bed') {
      if (p.cell !== drag.last) {
        // Paint every cell on the way so fast strokes don't leave gaps.
        const w = W(), [x0, y0] = [drag.last % w, Math.floor(drag.last / w)];
        const steps = Math.max(Math.abs(p.x - x0), Math.abs(p.y - y0));
        for (let i = 1; i <= steps; i++) paintBed(Math.round(y0 + ((p.y - y0) * i) / steps) * w + Math.round(x0 + ((p.x - x0) * i) / steps));
        drag.last = p.cell;
        changed();
      }
    } else if (drag.path) {
      extendPath(p.cell);
      board.draw();
    } else if (drag.tool === 'move') {
      const dx = p.x - drag.from.x, dy = p.y - drag.from.y;
      drag.moved = shifted(drag.dragon.body, dx, dy);
      drag.movedTwin = drag.twin ? drag.moved.map((c) => M.mirrorCell(m, c)) : null;
      const ignore = [drag.dragon, drag.twin].filter(Boolean);
      drag.valid = bodyValid(drag.moved, ignore) && (!drag.movedTwin || (bodyValid(drag.movedTwin, ignore) && !drag.movedTwin.some((c) => drag.moved.includes(c))));
      board.draw();
    } else if (drag.tool === 'erase') {
      const o = strokeOrient(drag.lastP, p);
      for (const q of along(drag.lastP, p)) eraseAt(q, o);
      drag.lastP = p;
    }
  }
  /** Points every quarter cell from a to b (b included), in the same shape as board.pointer(). */
  function along(a, b) {
    if (!a) return [b];
    const n = Math.max(1, Math.ceil(Math.hypot(b.fx - a.fx, b.fy - a.fy) / 0.25));
    const out = [];
    for (let i = 1; i <= n; i++) {
      const fx = a.fx + ((b.fx - a.fx) * i) / n, fy = a.fy + ((b.fy - a.fy) * i) / n;
      const x = Math.min(W() - 1, Math.floor(fx)), y = Math.min(H() - 1, Math.floor(fy));
      out.push({ fx, fy, x, y, cell: y * W() + x });
    }
    return out;
  }
  function up() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.path) {
      if (d.path.length >= 2) {
        checkpoint();
        const dragon = { team: d.team, body: d.path.slice() };
        m.dragons.push(dragon);
        if (mirrorOn()) {
          const twin = M.mirrorDragon(m, dragon);
          if (twin && bodyValid(twin.body, [])) m.dragons.push(twin);
          else flashHint('The mirrored dragon would overlap something, so only this one was added.');
        }
        changed();
      } else { flashHint('A dragon needs at least 2 cells: drag from its head along its body.'); board.draw(); }
    } else if (d.tool === 'move') {
      if (d.moved !== d.dragon.body && d.valid) {
        checkpoint();
        d.dragon.body = d.moved;
        if (d.twin) d.twin.body = d.movedTwin;
        changed();
      } else board.draw();
    } else if (d.tool === 'erase' && !d.touched) hist.undo.pop();
  }
  let hintTimer = 0;
  function flashHint(text) {
    const el = $('#ed-hint');
    el.textContent = text;
    el.classList.add('ed-flash');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.classList.remove('ed-flash'); syncControls(); }, 3500);
  }
  cv.addEventListener('pointerdown', down);
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { if (!drag) { hover = null; board.draw(); cellInfo(null); } });

  const keys = (ev) => {
    if (ev.target.closest?.('input, select, textarea')) return;
    const k = ev.key.toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if ((ev.metaKey || ev.ctrlKey) && k === 'y') { ev.preventDefault(); redo(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (k === 'escape') { pending = null; drag = null; board.draw(); return; }
    if (k === 'm' && m.symmetry !== 'none') { ED.mirror = !ED.mirror; syncControls(); return; }
    const t = TOOLS.find((x) => x.key === k);
    if (t) setTool(t.id);
  };
  addEventListener('keydown', keys);

  if (new URLSearchParams(location.search).has('dev')) window.__ws = { get m() { return m; }, mirrorOn, bodyValid, entry };
  syncControls();
  applyView();
  renderSide();
  return () => { removeEventListener('keydown', keys); board.destroy(); if (frame) cancelLater(frame); persist(entry); };
}
