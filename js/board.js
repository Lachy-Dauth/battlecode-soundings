// The board, drawn like a hydrographic chart: a neatline border with
// coordinate ticks, kelp as wavy lines along cell edges, portals as numbered
// magenta pairs, pearl beds as buoy rings sized by how often they spawn.
// Heat layers and dragons are painted underneath/over that chart work.

const EDGE_KELP = 1, EDGE_PORTAL = 2;

// Sequential ramps (light → deep). Blue is "you", orange is "opponent".
export const RAMPS = {
  you: ['#dbe9fb', '#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d2f57'],
  opp: ['#fde6da', '#f9c7ad', '#f3a17a', '#eb7a4a', '#d95926', '#ad4119', '#7e2e10', '#55200b'],
  neutral: ['#e2ece9', '#bfd6d0', '#93bab1', '#679c91', '#467f74', '#2f635a', '#1f4841', '#13302b'],
};
const RAMPS_DARK = {
  you: ['#10233a', '#133257', '#184577', '#1f5c9c', '#2f78c4', '#5598e7', '#86b6ef', '#cde2fb'],
  opp: ['#2c160c', '#4a200e', '#6d2c12', '#963c17', '#c24f1e', '#e0703f', '#f19c73', '#fbd5c0'],
  neutral: ['#132421', '#17342f', '#1d463f', '#255a51', '#2f7064', '#44877a', '#6cab9d', '#b1d8cf'],
};

function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(a[2] + (b[2] - a[2]) * u)})`;
}
export function rampCss(kind, dark, steps = 8) {
  const stops = (dark ? RAMPS_DARK : RAMPS)[kind];
  return Array.from({ length: steps }, (_, i) => rampColor(stops, i / (steps - 1)));
}

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

/** Robust colour scale top: the 98th percentile of non-zero values. */
export function scaleTop(values) {
  const nz = [];
  for (const v of values) if (v > 0) nz.push(Math.abs(v));
  if (!nz.length) return 1;
  nz.sort((a, b) => a - b);
  return nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.98))] || nz[nz.length - 1];
}

export class Board {
  /**
   * host: element to draw into. geom: { width, height, symmetry, hKind, vKind, beds, bedMin, bedMax, portals, spawns }.
   * opts.onHover(cell|null, info) for tooltips; opts.maxHeight caps the drawing height.
   */
  constructor(host, geom, opts = {}) {
    this.host = host;
    this.geom = geom;
    this.opts = opts;
    this.layer = null;       // { values, kind: 'you'|'opp'|'neutral'|'diverge', top }
    this.marks = [];         // [{ cell, color, size, shape }]
    this.dragons = null;     // Int32Array snapshot: id, team, len, cells...
    this.pearls = null;      // Int32Array: cell, src
    this.bedShare = null;    // Float32Array per cell: -1..1 who harvested each bed
    this.showSpawns = true;
    this.highlight = -1;
    this.flipTeams = false;  // draw B as "you"
    host.classList.add('board');
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.highlight = -1; this.draw(); opts.onHover?.(null); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
  }

  destroy() { this.ro.disconnect(); this.canvas.remove(); }

  set(props) { Object.assign(this, props); this.draw(); }

  metrics() {
    const { width: W, height: H } = this.geom;
    const pad = 22; // room for the neatline and its ticks
    const avail = Math.max(120, this.host.clientWidth - pad * 2);
    const maxH = this.opts.maxHeight || 640;
    const cell = Math.max(3, Math.min(avail / W, (maxH - pad * 2) / H, 36));
    return { cell, pad, W, H, w: cell * W + pad * 2, h: cell * H + pad * 2 };
  }

  cellAt(e) {
    const m = this.metrics();
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - m.pad) / m.cell), y = Math.floor((e.clientY - r.top - m.pad) / m.cell);
    return x >= 0 && y >= 0 && x < m.W && y < m.H ? y * m.W + x : -1;
  }

  hover(e) {
    const c = this.cellAt(e);
    if (c === this.highlight) return;
    this.highlight = c;
    this.draw();
    this.opts.onHover?.(c < 0 ? null : c, e);
  }

  draw() {
    const g = this.geom, m = this.metrics(), dark = isDark();
    const css = getComputedStyle(this.host);
    const v = (name) => css.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio || 1;
    const cv = this.canvas;
    if (cv.width !== Math.round(m.w * dpr) || cv.height !== Math.round(m.h * dpr)) {
      cv.width = Math.round(m.w * dpr); cv.height = Math.round(m.h * dpr);
      cv.style.width = `${m.w}px`; cv.style.height = `${m.h}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.w, m.h);
    const { cell: s, pad: P, W, H } = m;
    const X = (x) => P + x * s, Y = (y) => P + y * s;

    // Water.
    ctx.fillStyle = v('--chart-water');
    ctx.fillRect(P, P, W * s, H * s);

    // Heat.
    if (this.layer) {
      const { values, kind } = this.layer;
      const top = this.layer.top || scaleTop(values);
      const stops = (dark ? RAMPS_DARK : RAMPS);
      const weight = this.layer.weight;
      const wTop = weight ? scaleTop(weight) : 1;
      for (let c = 0; c < values.length; c++) {
        const val = values[c];
        if (!val && !(weight && weight[c])) continue;
        const x = c % W, y = (c - x) / W;
        if (kind === 'share') {
          // val is your share minus theirs (-1..1); opacity follows how busy the cell is.
          ctx.globalAlpha = 0.18 + 0.82 * Math.sqrt(Math.min(1, weight[c] / wTop));
          ctx.fillStyle = Math.abs(val) < 0.04 ? v('--chart-even') : rampColor(val >= 0 ? stops.you : stops.opp, 0.15 + 0.85 * Math.min(1, Math.abs(val)));
        } else if (kind === 'diverge') {
          const t = Math.sign(val) * Math.sqrt(Math.min(1, Math.abs(val) / top));
          ctx.fillStyle = rampColor(t >= 0 ? stops.you : stops.opp, 0.12 + 0.88 * Math.abs(t));
        } else {
          ctx.fillStyle = rampColor(stops[kind] || stops.neutral, 0.1 + 0.9 * Math.sqrt(Math.min(1, val / top)));
        }
        ctx.fillRect(X(x), Y(y), s + 0.5, s + 0.5);
      }
      ctx.globalAlpha = 1;
    }

    // Graticule.
    if (s >= 7) {
      ctx.strokeStyle = v('--chart-grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < W; x++) { ctx.moveTo(Math.round(X(x)) + 0.5, P); ctx.lineTo(Math.round(X(x)) + 0.5, P + H * s); }
      for (let y = 1; y < H; y++) { ctx.moveTo(P, Math.round(Y(y)) + 0.5); ctx.lineTo(P + W * s, Math.round(Y(y)) + 0.5); }
      ctx.stroke();
    }

    // Pearl beds: buoy rings, larger for faster beds.
    if (g.beds) {
      for (let c = 0; c < g.beds.length; c++) {
        if (!g.beds[c]) continue;
        const x = c % W, y = (c - x) / W;
        const gap = (g.bedMin[c] + g.bedMax[c]) / 2 || 1;
        const r = Math.max(1.2, s * (0.1 + 0.16 * Math.min(1, 12 / gap)));
        ctx.beginPath();
        ctx.arc(X(x + 0.5), Y(y + 0.5), r, 0, Math.PI * 2);
        if (this.bedShare && this.bedShare[c] !== 0 && !Number.isNaN(this.bedShare[c])) {
          const t = this.bedShare[c];
          ctx.fillStyle = rampColor((dark ? RAMPS_DARK : RAMPS)[t > 0 ? 'you' : 'opp'], 0.35 + 0.65 * Math.abs(t));
          ctx.fill();
        }
        ctx.lineWidth = Math.max(1, s * 0.06);
        ctx.strokeStyle = v('--chart-bed');
        ctx.stroke();
      }
    }

    // Starting positions.
    if (this.showSpawns && g.spawns && !this.dragons) {
      ctx.setLineDash([Math.max(2, s * 0.25), Math.max(2, s * 0.2)]);
      for (const sp of g.spawns) {
        const team = this.flipTeams ? 1 - sp.team : sp.team;
        this.strokeBody(sp.body, team === 0 ? v('--you') : v('--opp'), Math.max(1.5, s * 0.12), X, Y, s, W);
      }
      ctx.setLineDash([]);
    }

    // Pearls on the board (replay view).
    if (this.pearls) {
      const p = this.pearls;
      for (let i = 0; i < p.length; i += 2) {
        const c = p[i], src = p[i + 1], x = c % W, y = (c - x) / W;
        ctx.beginPath();
        ctx.arc(X(x + 0.5), Y(y + 0.5), Math.max(1.4, s * 0.2), 0, Math.PI * 2);
        ctx.fillStyle = v('--pearl');
        ctx.fill();
        if (src > 1) {
          const team = src - 2;
          ctx.lineWidth = Math.max(1, s * 0.09);
          ctx.strokeStyle = (this.flipTeams ? 1 - team : team) === 0 ? v('--you') : v('--opp');
          ctx.stroke();
        }
      }
    }

    // Dragons.
    if (this.dragons) {
      const d = this.dragons;
      for (let i = 0; i < d.length;) {
        const team = d[i + 1], len = d[i + 2];
        const body = d.subarray(i + 3, i + 3 + len);
        const shown = this.flipTeams ? 1 - team : team;
        const col = shown === 0 ? v('--you') : v('--opp');
        this.strokeBody(body, col, Math.max(2, s * 0.56), X, Y, s, W);
        const hx = body[0] % W, hy = (body[0] - hx) / W;
        ctx.beginPath();
        ctx.arc(X(hx + 0.5), Y(hy + 0.5), Math.max(2, s * 0.36), 0, Math.PI * 2);
        ctx.fillStyle = shown === 0 ? v('--you-deep') : v('--opp-deep');
        ctx.fill();
        i += 3 + len;
      }
    }

    // Kelp and portals: the chart work, drawn over everything else.
    const kelp = v('--kelp'), portal = v('--portal');
    ctx.lineCap = 'round';
    for (let c = 0; c < W * H; c++) {
      const x = c % W, y = (c - x) / W;
      for (const [kinds, horiz] of [[g.hKind, true], [g.vKind, false]]) {
        const k = kinds[c];
        if (!k) continue;
        const x0 = X(x), y0 = Y(y), x1 = horiz ? X(x + 1) : x0, y1 = horiz ? y0 : Y(y + 1);
        if (k === EDGE_KELP) {
          ctx.strokeStyle = kelp;
          ctx.lineWidth = Math.max(1.5, s * 0.16);
          this.wavy(x0, y0, x1, y1, s);
        } else if (k === EDGE_PORTAL) {
          ctx.strokeStyle = portal;
          ctx.lineWidth = Math.max(2, s * 0.22);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
      }
    }
    if (g.portals && s >= 10) {
      ctx.font = `600 ${Math.max(9, Math.min(12, s * 0.42))}px ${v('--font-ui')}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = portal;
      for (const p of g.portals) {
        for (const c of [p.a, p.b]) {
          const x = c % W, y = (c - x) / W;
          const [lx, ly] = p.orient === 'h' ? [X(x + 0.5), Y(y) + s * 0.28] : [X(x) + s * 0.28, Y(y + 0.5)];
          ctx.fillText(String(p.id), lx, ly);
        }
      }
    }

    // Marks (deaths, kills) over the chart.
    for (const mk of this.marks) {
      const x = mk.cell % W, y = (mk.cell - x) / W;
      const cx = X(x + 0.5), cy = Y(y + 0.5), r = Math.max(2.5, s * (mk.size || 0.3));
      ctx.lineWidth = Math.max(1.5, s * 0.1);
      ctx.strokeStyle = mk.color;
      ctx.beginPath();
      if (mk.shape === 'ring') ctx.arc(cx, cy, r, 0, Math.PI * 2);
      else { ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); }
      ctx.stroke();
    }

    // Neatline: a chart border with alternating ticks every cell (every 5 on big maps).
    const ink = v('--ink');
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.25;
    ctx.strokeRect(P - 0.5, P - 0.5, W * s + 1, H * s + 1);
    const band = 5;
    const every = s < 6 ? 5 : 1;
    ctx.fillStyle = ink;
    for (let x = 0; x < W; x += every) if ((x / every) % 2 === 0) {
      ctx.fillRect(X(x), P - band - 1, s * every, band);
      ctx.fillRect(X(x), P + H * s + 1, s * every, band);
    }
    for (let y = 0; y < H; y += every) if ((y / every) % 2 === 0) {
      ctx.fillRect(P - band - 1, Y(y), band, s * every);
      ctx.fillRect(P + W * s + 1, Y(y), band, s * every);
    }
    ctx.lineWidth = 1;
    ctx.strokeRect(P - band - 1.5, P - band - 1.5, W * s + band * 2 + 3, H * s + band * 2 + 3);

    // Hovered cell.
    if (this.highlight >= 0) {
      const x = this.highlight % W, y = (this.highlight - x) / W;
      ctx.strokeStyle = v('--portal');
      ctx.lineWidth = 2;
      ctx.strokeRect(X(x) + 1, Y(y) + 1, s - 2, s - 2);
    }
  }

  /** A dragon body as one stroke, broken wherever it wraps the torus or crosses a portal. */
  strokeBody(body, color, width, X, Y, s, W) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let px = -9, py = -9;
    for (let i = 0; i < body.length; i++) {
      const x = body[i] % W, y = (body[i] - x) / W;
      const cx = X(x + 0.5), cy = Y(y + 0.5);
      // A new run starts at the head and wherever the body wraps or goes through a portal;
      // the tiny first segment makes single cells draw as round dots.
      if (i === 0 || Math.abs(x - px) + Math.abs(y - py) !== 1) { ctx.moveTo(cx, cy); ctx.lineTo(cx + 0.01, cy); }
      else ctx.lineTo(cx, cy);
      px = x; py = y;
    }
    ctx.stroke();
  }

  wavy(x0, y0, x1, y1, s) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (s < 12) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); return; }
    const len = Math.hypot(x1 - x0, y1 - y0), nx = (x1 - x0) / len, ny = (y1 - y0) / len;
    const amp = s * 0.09, waves = 2;
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, off = Math.sin(t * Math.PI * 2 * waves) * amp;
      const px = x0 + nx * len * t - ny * off, py = y0 + ny * len * t + nx * off;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
  }
}
