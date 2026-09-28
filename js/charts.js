// SVG charts: series over rounds, butterfly comparisons, pearl flow, columns.
// Colour comes from CSS classes (.you / .opp / .c-<cause>) so themes apply.

const NS = 'http://www.w3.org/2000/svg';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
export const pct = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(d)}%`);

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function niceTicks(max, count = 4) {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => max / st <= count) || 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(+v.toFixed(6));
  return { top, ticks };
}
function tipBox(host) {
  let t = host.querySelector(':scope > .tip');
  if (!t) { t = document.createElement('div'); t.className = 'tip'; host.appendChild(t); }
  return t;
}
function place(tip, host, x, y) {
  const w = tip.offsetWidth, hw = host.clientWidth;
  tip.style.left = `${Math.max(0, Math.min(hw - w, x + 14))}px`;
  tip.style.top = `${Math.max(0, y)}px`;
}
function observe(host, draw) {
  if (host._ro) host._ro.disconnect();
  host._ro = new ResizeObserver(() => draw());
  host._ro.observe(host);
  draw();
}

/**
 * Series over rounds.
 * series: [{ name, values, cls, band?: { lo, hi }, dashed? }]
 * opts: { height, yLabel, markers: [{ x, label }], cursor: round, onPick(round) }
 */
export function roundsChart(host, series, opts = {}) {
  host.classList.add('chart');
  host.innerHTML = '';
  const tip = tipBox(host);
  const svg = el('svg', { role: 'img', 'aria-label': opts.label || 'chart' }, host);
  const n = Math.max(1, ...series.map((s) => s.values.length));
  const max = opts.max ?? Math.max(1, ...series.flatMap((s) => [...s.values, ...(s.band ? s.band.hi : [])]));
  const y = niceTicks(max, 4);
  const suffix = opts.suffix || '';
  const draw = () => {
    const W = Math.max(260, host.clientWidth), H = opts.height || 220, m = { l: 40, r: 12, t: 10, b: 24 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = '';
    const X = (i) => m.l + (i / Math.max(1, n - 1)) * (W - m.l - m.r);
    const Y = (v) => H - m.b - (v / y.top) * (H - m.t - m.b);
    const g = el('g', { class: 'grid' }, svg);
    for (const v of y.ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, g);
      el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }, g).textContent = `${fmt(v)}${suffix}`;
    }
    const xStep = niceTicks(n, Math.max(2, Math.floor((W - m.l) / 80))).ticks;
    for (const r of xStep) if (r < n) el('text', { x: X(r), y: H - 6, 'text-anchor': 'middle', class: 'axis' }, g).textContent = r;
    // Markers: labels step down when they would collide with the previous one.
    let lastX = -1e9, row = 0;
    for (const mk of [...(opts.markers || [])].sort((a, b) => a.x - b.x)) {
      if (mk.x < 0 || mk.x >= n) continue;
      const px = X(mk.x);
      row = px - lastX < 110 ? row + 1 : 0;
      lastX = px;
      el('line', { x1: px, x2: px, y1: m.t, y2: H - m.b, class: 'marker' }, svg);
      el('text', { x: px + 4, y: m.t + 10 + row * 13, class: 'marker-label' }, svg).textContent = mk.label;
    }
    for (const s of series) {
      if (s.band && s.band.lo.length) {
        let d = '';
        s.band.hi.forEach((v, i) => { d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
        for (let i = s.band.lo.length - 1; i >= 0; i--) d += `L${X(i).toFixed(1)},${Y(s.band.lo[i]).toFixed(1)}`;
        el('path', { d: `${d}Z`, class: `band ${s.cls}` }, svg);
      }
    }
    for (const s of series) {
      if (!s.values.length) continue;
      let d = '';
      s.values.forEach((v, i) => { d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
      el('path', { d, class: `line ${s.cls}${s.dashed ? ' dashed' : ''}` }, svg);
    }
    const cursor = el('line', { y1: m.t, y2: H - m.b, class: 'cursor', visibility: opts.cursor != null ? 'visible' : 'hidden',
      x1: X(opts.cursor ?? 0), x2: X(opts.cursor ?? 0) }, svg);
    const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
    const dots = series.map((s) => el('circle', { r: 3.5, class: `dot ${s.cls}`, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
    const at = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      return Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
    };
    hit.addEventListener('pointermove', (ev) => {
      const i = at(ev);
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      const rows = [];
      series.forEach((s, k) => {
        const v = s.values[i];
        if (v == null) { dots[k].setAttribute('visibility', 'hidden'); return; }
        dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('visibility', 'visible');
        const band = s.band && s.band.lo[i] != null ? ` <span class="muted">(${fmt(s.band.lo[i])}–${fmt(s.band.hi[i])})</span>` : '';
        rows.push(`<div><i class="key ${s.cls}"></i>${esc(s.name)} <b>${fmt(v, s.decimals || 0)}${suffix}</b>${band}</div>`);
      });
      tip.innerHTML = `<div class="tip-h">Round ${i}${opts.nAt ? `, ${opts.nAt(i)}` : ''}</div>${rows.join('')}`;
      tip.style.display = 'block';
      place(tip, host, (X(i) / W) * r0().width, 6);
    });
    const r0 = () => svg.getBoundingClientRect();
    hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });
    if (opts.onPick) hit.addEventListener('click', (ev) => opts.onPick(at(ev)));
    host._setCursor = (i) => { cursor.setAttribute('x1', X(i)); cursor.setAttribute('x2', X(i)); cursor.setAttribute('visibility', 'visible'); };
  };
  observe(host, draw);
}

/**
 * Butterfly: your value grows left, the opponent's right, one row per category.
 * rows: [{ label, you, opp, cls, note }]
 */
export function butterfly(host, rows, { unit = '', youLabel = 'You', oppLabel = 'Opponent', decimals = 1 } = {}) {
  const max = Math.max(1e-9, ...rows.flatMap((r) => [r.you, r.opp]));
  host.innerHTML = `
    <div class="bf-head"><span class="you-ink">${esc(youLabel)}</span><span></span><span class="opp-ink">${esc(oppLabel)}</span></div>
    ${rows.map((r) => `
      <div class="bf-row" title="${esc(r.note || '')}">
        <div class="bf-side left"><span class="bf-val">${fmt(r.you, decimals)}${unit}</span><div class="bf-bar you ${r.cls || ''}" style="width:${(r.you / max) * 100}%"></div></div>
        <div class="bf-label">${r.swatch ? `<i class="swatch ${r.cls}"></i>` : ''}${esc(r.label)}</div>
        <div class="bf-side right"><div class="bf-bar opp ${r.cls || ''}" style="width:${(r.opp / max) * 100}%"></div><span class="bf-val">${fmt(r.opp, decimals)}${unit}</span></div>
      </div>`).join('')}`;
  host.classList.add('butterfly');
}

/**
 * Two-column flow: sources on the left, destinations on the right, bands sized by count.
 * sources/targets: [{ id, label, cls }]; links: [{ from, to, value }]
 */
export function flowChart(host, sources, targets, links, { unit = 'pearls' } = {}) {
  host.classList.add('chart', 'flow');
  host.innerHTML = '';
  const tip = tipBox(host);
  const svg = el('svg', { role: 'img', 'aria-label': 'Pearl flow' }, host);
  const total = links.reduce((s, l) => s + l.value, 0) || 1;
  const draw = () => {
    const W = Math.max(300, host.clientWidth), H = 260, nodeW = 12, gap = 10, labelW = Math.min(170, W * 0.3);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = '';
    const scale = (H - gap * (Math.max(sources.length, targets.length) - 1) - 8) / total;
    const layout = (nodes, key) => {
      let yy = 4;
      return new Map(nodes.map((nd) => {
        const v = links.filter((l) => l[key] === nd.id).reduce((s, l) => s + l.value, 0);
        const h = Math.max(v ? 2 : 0, v * scale);
        const out = [nd.id, { ...nd, y: yy, h, v, off: 0 }];
        yy += h + (v ? gap : 0);
        return out;
      }));
    };
    const L = layout(sources, 'from'), R = layout(targets, 'to');
    const x0 = labelW, x1 = W - labelW;
    for (const l of links) {
      if (!l.value) continue;
      const a = L.get(l.from), b = R.get(l.to), h = l.value * scale;
      const ya = a.y + a.off, yb = b.y + b.off;
      a.off += h; b.off += h;
      const mx = (x0 + nodeW + x1) / 2;
      const d = `M${x0 + nodeW},${ya} C${mx},${ya} ${mx},${yb} ${x1},${yb} L${x1},${yb + h} C${mx},${yb + h} ${mx},${ya + h} ${x0 + nodeW},${ya + h} Z`;
      const p = el('path', { d, class: `flow-link ${a.cls}` }, svg);
      p.addEventListener('pointermove', (ev) => {
        const r = host.getBoundingClientRect();
        tip.innerHTML = `<b>${fmt(l.value)}</b> ${unit}: ${esc(a.label)} → ${esc(b.label)}<div class="muted">${pct(l.value / (a.v || 1))} of ${esc(a.label.toLowerCase())}</div>`;
        tip.style.display = 'block';
        place(tip, host, ev.clientX - r.left, ev.clientY - r.top - 40);
      });
      p.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    }
    for (const [map, x, anchor, tx] of [[L, x0, 'end', x0 - 8], [R, x1, 'start', x1 + nodeW + 8]]) {
      for (const nd of map.values()) {
        if (!nd.v) continue;
        el('rect', { x, y: nd.y, width: nodeW, height: nd.h, rx: 2, class: `flow-node ${nd.cls}` }, svg);
        const t = el('text', { x: tx, y: nd.y + nd.h / 2 + 4, 'text-anchor': anchor, class: 'flow-label' }, svg);
        t.textContent = `${nd.label} `;
        const b = el('tspan', { class: 'flow-num' }, t);
        b.textContent = fmt(nd.v);
      }
    }
  };
  observe(host, draw);
}

/** Columns with hover: bars [{ label, value, tip, cls }]. */
export function columns(host, bars, { height = 160, fmtY = (v) => fmt(v), sparse = false } = {}) {
  host.classList.add('chart');
  host.innerHTML = '';
  const tip = tipBox(host);
  const svg = el('svg', { role: 'img' }, host);
  const y = niceTicks(Math.max(1, ...bars.map((b) => b.value)), 3);
  const draw = () => {
    const W = Math.max(240, host.clientWidth), H = height, m = { l: 36, r: 6, t: 8, b: 22 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = '';
    const Y = (v) => H - m.b - (v / y.top) * (H - m.t - m.b);
    const g = el('g', { class: 'grid' }, svg);
    for (const v of y.ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, g);
      el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }, g).textContent = fmtY(v);
    }
    const slot = (W - m.l - m.r) / Math.max(1, bars.length), bw = Math.max(1, Math.min(34, slot - 2));
    const every = sparse ? 1 : Math.ceil(bars.length / Math.max(2, Math.floor((W - m.l) / 46)));
    bars.forEach((b, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      if (b.value > 0) el('rect', { x, y: Y(b.value), width: bw, height: Math.max(0.5, H - m.b - Y(b.value)), rx: Math.min(3, bw / 3), class: `col ${b.cls || 'neutral'}` }, svg);
      if (b.label !== '' && (sparse || i % every === 0)) el('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' }, g).textContent = b.label;
      const hit = el('rect', { x: m.l + i * slot, y: m.t, width: slot, height: H - m.t - m.b, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', (ev) => {
        tip.innerHTML = b.tip;
        tip.style.display = 'block';
        const r = host.getBoundingClientRect();
        place(tip, host, ev.clientX - r.left, 4);
      });
      hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    });
  };
  observe(host, draw);
}

/** A single 100% bar split into labelled parts: [{ label, value, cls }]. */
export function splitBar(parts, { unit = '' } = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return `<div class="splitbar" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${pct(p.value / total)}`).join(', '))}">
    ${parts.filter((p) => p.value > 0).map((p) => `<div class="seg ${p.cls}" style="flex:${p.value}" title="${esc(p.label)}: ${fmt(p.value)}${unit} (${pct(p.value / total)})"></div>`).join('')}
  </div>
  <div class="splitbar-legend">${parts.map((p) => `<span><i class="swatch ${p.cls}"></i>${esc(p.label)} <b>${pct(p.value / total)}</b></span>`).join('')}</div>`;
}
