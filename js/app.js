import { Pool, sourcesFrom, analyseAll } from './ingest.js';
import { selectGames, aggregate, seriesStats, mapLayer, botPopularity, botLabel, selfInflicted, enemyInflicted, resolveSide, outcome, leadStats } from './aggregate.js';
import { Board, scaleTop, rampCss } from './board.js';
import { roundsChart, butterfly, flowChart, columns, splitBar, esc, fmt, pct } from './charts.js';
import { CAUSES, CAUSE_LABEL, ENEMY_CAUSES } from './analyse.js';
import { parseMap } from './map.js';
import { HERO_MAP } from './hero-map.js';
import { viewEditor, addMapSources, addFromGeometry } from './editor.js';

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(`soundings.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`soundings.${k}`, JSON.stringify(v)); } catch {} },
};
const S = {
  games: [],
  errors: [],
  seen: new Set(),
  prints: new Set(),
  duplicates: 0,
  loading: null,
  perspective: store.get('perspective', 'auto'),
  filters: { map: 'all', result: 'all', bot: 'all', opp: 'all' },
  geoms: new Map(),
  mapView: { layer: 'territory', flip: true, causes: 'all', phase: 'all' },
  detail: new Map(),
};
let pool = null;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
const perGame = (v, n) => (n ? v / n : 0);
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const CAUSE_ORDER = CAUSES;

// ---------------------------------------------------------------------------
// intake
// ---------------------------------------------------------------------------
async function ingest(all) {
  // Map files go to the map editor's library; everything else is a replay.
  const maps = all.filter((s) => s.kind === 'map');
  const sources = all.filter((s) => s.kind !== 'map');
  if (maps.length) {
    const res = await addMapSources(maps);
    const bits = [`${plural(res.added.length, 'map')} added to the map editor`];
    if (res.duplicates) bits.push(`${res.duplicates} already there`);
    if (res.errors.length) bits.push(`${res.errors.length} couldn't be read`);
    flash(`${bits.join(', ')}.`);
    if (!sources.length) {
      if (location.hash.startsWith('#/editor')) route(); else location.hash = '#/editor';
      return;
    }
  }
  const fresh = sources.filter((s) => !S.seen.has(`${s.path}|${s.size}`));
  if (!fresh.length) { flash(sources.length ? 'Those replays are already loaded.' : 'No replays found in that selection.'); return; }
  pool ||= new Pool();
  const job = { total: fresh.length, done: 0, failed: 0, started: performance.now() };
  S.loading = job;
  renderProgress();
  let last = 0;
  const tick = () => {
    const now = performance.now();
    if (now - last > 450) { last = now; renderProgress(); rerender(true); }
  };
  await analyseAll(pool, fresh, {
    onGame(src, g) {
      S.seen.add(`${src.path}|${src.size}`);
      job.done++;
      if (S.prints.has(g.fingerprint)) { S.duplicates++; job.dupes = (job.dupes || 0) + 1; tick(); return; }
      S.prints.add(g.fingerprint);
      const uid = S.games.length + 1;
      if (!S.geoms.has(g.map.key)) S.geoms.set(g.map.key, g.geometry);
      g.geometry = null;
      S.games.push({ uid, name: src.name, path: src.path, size: src.size, src, g });
      tick();
    },
    onError(src, err) {
      S.errors.push({ name: src.name, path: src.path, error: err.message });
      job.done++; job.failed++;
      tick();
    },
  });
  job.ms = performance.now() - job.started;
  S.loading = null;
  renderProgress(job);
  if (!location.hash || location.hash === '#/' ) location.hash = '#/overview';
  else rerender();
}

function renderProgress(finished) {
  const box = $('#progress');
  const job = S.loading;
  if (job) {
    box.hidden = false;
    box.innerHTML = `<span>Reading ${fmt(job.done)} of ${fmt(job.total)}</span><span class="meter"><div style="width:${(job.done / job.total) * 100}%"></div></span>`;
  } else if (finished) {
    box.hidden = false;
    const games = finished.total - finished.failed - (finished.dupes || 0);
    box.innerHTML = `<span>${plural(games, 'game')} read in ${(finished.ms / 1000).toFixed(1)} s${finished.dupes ? `, ${fmt(finished.dupes)} identical ${finished.dupes === 1 ? 'copy' : 'copies'} skipped` : ''}${finished.failed ? `, ${finished.failed} failed` : ''}</span>`;
    setTimeout(() => { if (!S.loading) box.hidden = true; }, 6000);
  } else box.hidden = true;
  $('#add').hidden = !S.games.length;
  $('#tabs').hidden = false;
  for (const a of $$('#tabs a[data-view]')) if (a.dataset.view !== 'editor') a.hidden = !S.games.length;
}

function flash(msg) {
  const box = $('#progress');
  box.hidden = false;
  box.innerHTML = `<span>${esc(msg)}</span>`;
  setTimeout(() => { if (!S.loading) box.hidden = true; }, 4000);
}

function setupIntake() {
  const files = $('#pick-files'), folder = $('#pick-folder'), dz = $('#dropzone');
  const fromInput = async (input) => { const s = await sourcesFrom({ files: input.files }); input.value = ''; ingest(s); };
  files.onchange = () => fromInput(files);
  folder.onchange = () => fromInput(folder);
  $('#add').onclick = () => files.click();
  let depth = 0;
  addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { depth++; dz.hidden = false; } });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.hidden = true; });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; dz.hidden = true;
    const items = e.dataTransfer.items ? [...e.dataTransfer.items].filter((i) => i.kind === 'file') : null;
    const s = await sourcesFrom(items && items.length ? { items } : { files: e.dataTransfer.files });
    ingest(s);
  });
}

// ---------------------------------------------------------------------------
// filters and perspective
// ---------------------------------------------------------------------------
function currentSelection() { return selectGames(S.games, S); }

function renderFilters() {
  const bar = $('#filters');
  if (!S.games.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const popular = botPopularity(S.games);
  const names = [...popular.entries()].sort((a, b) => b[1] - a[1]);
  const all = S.games.map((x) => ({ ...x, side: resolveSide(x.g, S.perspective, popular) })).filter((x) => x.side >= 0);
  const yours = new Map(), theirs = new Map(), maps = new Map();
  for (const x of all) {
    const you = x.side === 0 ? x.g.botA : x.g.botB, opp = x.side === 0 ? x.g.botB : x.g.botA;
    yours.set(you, (yours.get(you) || 0) + 1);
    theirs.set(opp, (theirs.get(opp) || 0) + 1);
    const m = maps.get(x.g.map.key) || { name: x.g.map.name, n: 0 };
    m.n++; maps.set(x.g.map.key, m);
  }
  const sel = currentSelection();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const auto = describeAuto(popular);
  bar.innerHTML = `
    <label>You are <select id="f-persp">
      ${opt('auto', `Detected: ${auto}`, S.perspective)}
      ${names.map(([n, c]) => opt(`bot:${n}`, `${botLabel(n)} (${c})`, S.perspective)).join('')}
      ${opt('A', 'Team A in every game', S.perspective)}${opt('B', 'Team B in every game', S.perspective)}
    </select></label>
    <label>Map <select id="f-map">${opt('all', `All maps (${maps.size})`, S.filters.map)}${[...maps.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, m]) => opt(k, `${m.name} (${m.n})`, S.filters.map)).join('')}</select></label>
    <label>Result <select id="f-result">${opt('all', 'Any', S.filters.result)}${opt('win', 'Wins', S.filters.result)}${opt('loss', 'Losses', S.filters.result)}${opt('draw', 'Draws', S.filters.result)}</select></label>
    ${yours.size > 1 ? `<label>Your bot <select id="f-bot">${opt('all', `Any (${yours.size})`, S.filters.bot)}${[...yours.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => opt(k, `${botLabel(k)} (${n})`, S.filters.bot)).join('')}</select></label>` : ''}
    ${theirs.size > 1 ? `<label>Opponent <select id="f-opp">${opt('all', `Any (${theirs.size})`, S.filters.opp)}${[...theirs.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => opt(k, `${botLabel(k)} (${n})`, S.filters.opp)).join('')}</select></label>` : ''}
    <span class="spacer"></span>
    <span class="muted num">${plural(sel.length, 'game')} of ${fmt(S.games.length)}</span>
    ${Object.values(S.filters).some((v) => v !== 'all') ? '<button class="btn" id="f-clear" type="button">Clear filters</button>' : ''}`;
  $('#f-persp').onchange = (e) => { S.perspective = e.target.value; store.set('perspective', S.perspective); S.filters.bot = 'all'; S.filters.opp = 'all'; rerender(); };
  for (const [id, key] of [['#f-map', 'map'], ['#f-result', 'result'], ['#f-bot', 'bot'], ['#f-opp', 'opp']]) {
    const s = $(id);
    if (s) s.onchange = (e) => { S.filters[key] = e.target.value; rerender(); };
  }
  const c = $('#f-clear');
  if (c) c.onclick = () => { S.filters = { map: 'all', result: 'all', bot: 'all', opp: 'all' }; rerender(); };
}

function describeAuto(popular) {
  let server = 0, named = 0, blank = 0;
  const top = popular.you ? [popular.you] : null;
  for (const x of S.games) {
    const a = x.g.botA, b = x.g.botB;
    if ((a && !b) || (b && !a)) server++; else if (a && b) named++; else blank++;
  }
  if (server && !named && !blank) {
    const ids = new Set(S.games.map((x) => x.g.botA || x.g.botB));
    return ids.size === 1 ? botLabel([...ids][0]) : `your submissions (${ids.size})`;
  }
  if (named && top) return botLabel(top[0]);
  return 'team A';
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
let current = null;
function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = hash.split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
  current?.cleanup?.();
  current = null;
  window.scrollTo(0, 0);
  $$('#tabs a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.view === (view === 'game' ? 'games' : view)));
  $$('#tabs a').forEach((a) => a.getAttribute('aria-current') !== null && a.setAttribute('aria-current', 'page'));
  renderProgress();
  if (view === 'editor') {
    $('#filters').hidden = true;
    current = viewEditor(main, arg, {});
    document.title = 'Map editor: Soundings';
    return;
  }
  if (!S.games.length) { renderFilters(); current = viewLanding(); return; }
  renderFilters();
  if (view === 'maps') current = viewMaps(arg);
  else if (view === 'games') current = viewGames();
  else if (view === 'game') current = viewGame(Number(arg));
  else current = viewOverview();
  document.title = `${{ maps: 'Maps', games: 'Games', game: 'Game' }[view] || 'Overview'}: Soundings`;
}
let pendingRender = false;
function rerender(soft = false) {
  if (location.hash.startsWith('#/editor')) { if (!soft) route(); return; }
  if (soft && current?.soft === false) { renderFilters(); return; }
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => {
    pendingRender = false;
    // Queued before the user opened the editor: the editor redraws itself.
    if (location.hash.startsWith('#/editor')) return;
    if (!S.games.length) return;
    // First games in: leave the landing page, unless the user has already gone elsewhere.
    if (!current || current.landing) {
      if (!location.hash || location.hash === '#/') location.hash = '#/overview';
      else route();
      return;
    }
    renderFilters();
    const keepScroll = scrollY;
    current?.cleanup?.();
    const hash = location.hash.replace(/^#\/?/, '');
    const [view, ...rest] = hash.split('/');
    const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
    if (view === 'maps') current = viewMaps(arg);
    else if (view === 'games') current = viewGames();
    else if (view === 'game') current = viewGame(Number(arg));
    else current = viewOverview();
    scrollTo(0, keepScroll);
  });
}

// ---------------------------------------------------------------------------
// landing
// ---------------------------------------------------------------------------
function viewLanding() {
  main.innerHTML = `
    <section class="landing">
      <div class="landing-title">
        <h1>Soundings</h1>
        <p>Drop your Battlecode replays and see how your dragons live, eat and die: every death traced to its cause, every pearl to its source, every map as a chart.</p>
      </div>
      <div class="hero">
        <div class="hero-chart">
          <div id="hero-board"></div>
          <div class="sweep" aria-hidden="true"></div>
          <div class="hero-caption"><span><span class="chart-name">Autarky</span>, 54 by 18</span><span>Kelp, portals and pearl beds, with the two fleets' starting positions</span></div>
        </div>
        <div class="intake">
          <h2>Open replays</h2>
          <p>Use <b>.replay</b> files downloaded from the site or written by the toolkit, a folder of them, or a <b>.zip</b>. Hundreds at once is fine.</p>
          <button class="btn primary" id="l-files" type="button">Choose files or a zip</button>
          <button class="btn" id="l-folder" type="button">Choose a folder</button>
          <div class="drop-hint">or drop them anywhere on this page</div>
        </div>
      </div>
      <p class="privacy"><b>Nothing is uploaded.</b> Replays are decoded and analysed in this browser tab, then forgotten when you close it.</p>
      <p class="privacy">Making maps? The <a href="#/editor">map editor</a> opens .map files and zips of them, and lets you draw kelp, pearl beds, portals and dragons.</p>
      <div class="promises">
        <div>${glyph('death')}<h3>Where your length goes</h3><p>Every dead dragon is traced to kelp, its own body, a teammate, an enemy's body or a head-on crash, weighted by how long it was.</p></div>
        <div>${glyph('pearl')}<h3>The pearl economy</h3><p>How much you eat from natural beds versus corpses, how much of the enemy you ate, and how much of you fed them.</p></div>
        <div>${glyph('map')}<h3>Charts of every map</h3><p>Territory, head paths, and where you eat, die and kill, mirrored so you are always on the same side.</p></div>
      </div>
    </section>`;
  $('#l-files').onclick = () => $('#pick-files').click();
  $('#l-folder').onclick = () => $('#pick-folder').click();
  const geom = parseMap(HERO_MAP);
  const board = new Board($('#hero-board'), { ...geom, spawns: geom.dragons.map((d) => ({ team: d.team, body: d.body })), portals: geom.portalOf }, { maxHeight: 420, label: 'Chart of the Autarky map: kelp, portals, pearl beds and both starting positions' });
  return { landing: true, cleanup: () => board.destroy() };
}

function glyph(kind) {
  if (kind === 'death') return `<svg class="glyph" viewBox="0 0 120 34" aria-hidden="true"><rect x="0" y="12" width="46" height="10" rx="2" style="fill:var(--c-enemyHead)"/><rect x="48" y="12" width="28" height="10" style="fill:var(--c-self)"/><rect x="78" y="12" width="20" height="10" style="fill:var(--c-wall)"/><rect x="100" y="12" width="20" height="10" rx="2" style="fill:var(--c-allyBody)"/></svg>`;
  if (kind === 'pearl') return `<svg class="glyph" viewBox="0 0 120 34" aria-hidden="true"><path d="M4 6 C60 6 60 26 116 26 L116 32 C60 32 60 12 4 12Z" style="fill:var(--natural);opacity:.45"/><path d="M4 18 C60 18 60 4 116 4 L116 14 C60 14 60 28 4 28Z" style="fill:var(--opp);opacity:.45"/><rect x="0" y="4" width="5" height="26" style="fill:var(--ink)"/><rect x="115" y="2" width="5" height="30" style="fill:var(--you)"/></svg>`;
  return `<svg class="glyph" viewBox="0 0 120 34" aria-hidden="true">${Array.from({ length: 24 }, (_, i) => `<rect x="${(i % 12) * 10}" y="${Math.floor(i / 12) * 17}" width="9" height="16" style="fill:var(--${[3, 4, 5, 15, 16, 17].includes(i) ? 'you' : [8, 9, 20, 21].includes(i) ? 'opp' : 'rule'})"/>`).join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------
function viewOverview() {
  const sel = currentSelection();
  if (!sel.length) { main.innerHTML = emptyFiltered(); return {}; }
  const a = aggregate(sel);
  const n = a.n;
  const you = a.you, opp = a.opp;
  const lenYouSelf = selfInflicted(you, 'lenLostBy'), lenYouEnemy = enemyInflicted(you, 'lenLostBy');
  const lenOppSelf = selfInflicted(opp, 'lenLostBy'), lenOppEnemy = enemyInflicted(opp, 'lenLostBy');
  const topCause = CAUSES.map((c) => [c, you.lenLostBy[c]]).sort((x, y) => y[1] - x[1])[0];
  const winRate = a.win / n;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <div class="headline"><span class="w">${fmt(a.win)} won</span>, <span class="l">${fmt(a.loss)} lost</span>${a.draw ? `, ${fmt(a.draw)} drawn` : ''}</div>
        <p class="subline">${plural(n, 'game')}, ${pct(winRate)} won. Games last ${fmt(a.rounds / n)} rounds on average; ${fmt(a.elimWins)} of your wins and ${fmt(a.elimLosses)} of your losses ended by elimination.</p>
      </div>
      <div class="ribbon" aria-label="Every game's result">${sel.slice(0, 400).map((x) => `<a class="${x.res}" href="#/game/${x.uid}" title="${esc(x.g.map.name)}: ${x.res}, ${esc(x.name)}"></a>`).join('')}</div>
    </div>

    <section class="section">
      <header><h2>Where your length goes</h2><p>Every dragon that died, by what killed it, weighted by its length. Self-inflicted means kelp, your own body, a teammate, or an action the engine rejected.</p></header>
      <div class="cols-2-1">
        <div>
          <p class="insight">You lose <b>${fmt(perGame(you.lenLost, n), 1)}</b> length a game. <b>${pct(lenYouSelf / (you.lenLost || 1))}</b> of it is self-inflicted, against ${pct(lenOppSelf / (opp.lenLost || 1))} for your opponents. The biggest single drain is <b>${esc(CAUSE_LABEL[topCause[0]].toLowerCase())}</b>, ${fmt(perGame(topCause[1], n), 1)} length a game.</p>
          <div style="margin-top:18px" class="stack">
            <div class="legend"><span><b class="you-ink">You</b></span></div>
            ${splitBar([{ label: 'Enemy-inflicted', value: lenYouEnemy, cls: 'c-enemy' }, { label: 'Self-inflicted', value: lenYouSelf, cls: 'c-selfgroup' }], { unit: ' length' })}
            <div class="legend" style="margin-top:14px"><span><b class="opp-ink">Opponents</b></span></div>
            ${splitBar([{ label: 'Enemy-inflicted', value: lenOppEnemy, cls: 'c-enemy' }, { label: 'Self-inflicted', value: lenOppSelf, cls: 'c-selfgroup' }], { unit: ' length' })}
          </div>
        </div>
        <div class="figures">
          <div class="figure"><div class="k">Dragons lost a game</div><div class="v"><span class="you-ink">${fmt(perGame(you.lost, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.lost, n), 1)}</span></div></div>
          <div class="figure"><div class="k">Enemy dragons you killed</div><div class="v"><span class="you-ink">${fmt(perGame(you.kills, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.kills, n), 1)}</span></div><div class="s">per game; ${fmt(perGame(you.bodyKills, n), 1)} ran into your body</div></div>
          <div class="figure"><div class="k">Length you killed</div><div class="v"><span class="you-ink">${fmt(perGame(you.killLen, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.killLen, n), 1)}</span></div></div>
          <div class="figure"><div class="k">First blood lost</div><div class="v">${pct(a.firstBloodYou / Math.max(1, a.firstBloodYou + a.firstBloodOpp))}</div><div class="s">of games, you lost the first dragon</div></div>
        </div>
      </div>
      <div style="margin-top:26px">
        <div class="seg-ctl" id="cause-mode" role="group" aria-label="Measure"><button data-m="len" aria-pressed="true">Length lost</button><button data-m="count" aria-pressed="false">Dragons lost</button></div>
        <div id="causes" style="margin-top:14px"></div>
      </div>
    </section>

    <section class="section">
      <header><h2>Pearls</h2><p>Every pearl eaten, traced to where it came from. Dead dragons drop a pearl on every other segment.</p></header>
      <div class="cols-2-1">
        <div id="flow"></div>
        <div>
          <p class="insight">You eat <b>${fmt(perGame(you.eaten, n), 1)}</b> pearls a game; they eat ${fmt(perGame(opp.eaten, n), 1)}. <b>${pct(you.eatenEnemyCorpse / (you.eaten || 1))}</b> of your pearls come from their dead, and your own dead feed them ${fmt(perGame(you.droppedEatenByEnemy, n), 1)} pearls a game.</p>
          <div class="figures" style="margin-top:18px">
            <div class="figure"><div class="k">Natural pearls</div><div class="v"><span class="you-ink">${fmt(perGame(you.eatenNatural, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.eatenNatural, n), 1)}</span></div></div>
            <div class="figure"><div class="k">From enemy corpses</div><div class="v"><span class="you-ink">${fmt(perGame(you.eatenEnemyCorpse, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.eatenEnemyCorpse, n), 1)}</span></div></div>
            <div class="figure"><div class="k">Recycled own corpses</div><div class="v"><span class="you-ink">${fmt(perGame(you.eatenOwnCorpse, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.eatenOwnCorpse, n), 1)}</span></div></div>
            <div class="figure"><div class="k">Share of all eaten</div><div class="v">${pct(you.eaten / Math.max(1, you.eaten + opp.eaten))}</div><div class="s">yours, of every pearl eaten</div></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <header><h2>Length over the game</h2><p>Mean total length of each side by round, with the middle half of games shaded. Rounds are shown while at least three games are still going.</p></header>
      <div class="legend"><span><i class="key you"></i>You</span><span><i class="key opp"></i>Opponents</span></div>
      <div id="len-chart"></div>
      <div class="cols" style="margin-top:18px">
        <div><h3>Dragons alive</h3><div id="count-chart"></div></div>
        <div><h3>Pearls eaten so far</h3><div id="eat-chart"></div></div>
      </div>
    </section>

    <section class="section">
      <header><h2>When games turn</h2><p>Share of games you are ahead in, round by round, judged the way the engine scores a game at round 500: longest dragon first, then total length.</p></header>
      <div class="cols-2-1">
        <div><div class="legend"><span><i class="key you"></i>You're ahead</span><span><i class="key opp"></i>You're behind</span></div><div id="lead-chart"></div></div>
        <div id="lead-table"></div>
      </div>
    </section>

    <section class="section">
      <header><h2>Tactics</h2><p>How each side spends its turns.</p></header>
      <div class="figures">
        <div class="figure"><div class="k">Splits a game</div><div class="v"><span class="you-ink">${fmt(perGame(you.splits, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.splits, n), 1)}</span></div><div class="s">average child ${fmt(you.splitSegments / (you.splits || 1), 1)} long</div></div>
        <div class="figure"><div class="k">Sprints a game</div><div class="v"><span class="you-ink">${fmt(perGame(you.sprints, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.sprints, n), 1)}</span></div><div class="s">${fmt(perGame(you.sprintPaid, n), 1)} segments paid for extra steps</div></div>
        <div class="figure"><div class="k">Peak dragons alive</div><div class="v"><span class="you-ink">${fmt(perGame(you.peakDragons, n), 1)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.peakDragons, n), 1)}</span></div></div>
        <div class="figure"><div class="k">Peak total length</div><div class="v"><span class="you-ink">${fmt(perGame(you.peakTotal, n), 0)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.peakTotal, n), 0)}</span></div></div>
        <div class="figure"><div class="k">Sonar pings a game</div><div class="v"><span class="you-ink">${fmt(perGame(you.pings, n), 0)}</span> <small>vs</small> <span class="opp-ink">${fmt(perGame(opp.pings, n), 0)}</span></div></div>
        ${you.measuredTurns ? `<div class="figure"><div class="k">Instructions a turn</div><div class="v you-ink">${fmtPow(you.instrSum / you.measuredTurns)}</div><div class="s">peak ${fmtPow(you.instrMax)}; ${fmt(you.tle)} timeouts, ${fmt(you.exceeded)} over budget</div></div>` : ''}
      </div>
    </section>

    <section class="section">
      <header><h2>By map</h2><p>Open a map to see its heatmaps.</p></header>
      ${breakdownTable(a.byMap, 'map')}
    </section>
    ${a.byBot.size > 1 ? `<section class="section"><header><h2>By your bot</h2><p>Each of your submissions or bot versions, side by side.</p></header>${breakdownTable(a.byBot, 'bot')}</section>` : ''}
    ${a.byOpp.size > 1 ? `<section class="section"><header><h2>By opponent</h2></header>${breakdownTable(a.byOpp, 'opp')}</section>` : ''}
    ${S.duplicates ? `<p class="muted section" style="font-size:13px">${plural(S.duplicates, 'file')} held a game identical to one already loaded and ${S.duplicates === 1 ? 'was' : 'were'} skipped: the same match saved twice (such as .replay and .replay.gz), or a rematch that played out move for move, which happens because the engine is deterministic.</p>` : ''}
    ${S.errors.length ? `<details class="errors section"><summary>${plural(S.errors.length, 'file')} couldn't be read</summary><ul>${S.errors.slice(0, 50).map((e) => `<li>${esc(e.path)}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}`;

  const drawCauses = (mode) => {
    const key = mode === 'len' ? 'lenLostBy' : 'lostBy';
    const rows = CAUSE_ORDER.filter((c) => you[key][c] || opp[key][c]).map((c) => ({
      label: CAUSE_LABEL[c], you: perGame(you[key][c], n), opp: perGame(opp[key][c], n), cls: `c-${c}`, swatch: true,
    }));
    butterfly($('#causes'), rows, { youLabel: `You, ${mode === 'len' ? 'length' : 'dragons'} a game`, oppLabel: `Opponents, ${mode === 'len' ? 'length' : 'dragons'} a game` });
  };
  drawCauses('len');
  $$('#cause-mode button').forEach((b) => { b.onclick = () => { $$('#cause-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawCauses(b.dataset.m); }; });

  const f = a.flow;
  flowChart($('#flow'),
    [{ id: 'nat', label: 'Natural beds', cls: 'c-natural' }, { id: 'yc', label: 'Your corpses', cls: 'c-you' }, { id: 'tc', label: 'Their corpses', cls: 'c-opp' }],
    [{ id: 'you', label: 'Eaten by you', cls: 'c-you' }, { id: 'opp', label: 'Eaten by them', cls: 'c-opp' }, { id: 'left', label: 'Never eaten', cls: 'c-natural' }],
    [
      { from: 'nat', to: 'you', value: f.natural[0] }, { from: 'nat', to: 'opp', value: f.natural[1] },
      { from: 'nat', to: 'left', value: Math.max(0, f.spawnedNatural - f.natural[0] - f.natural[1]) },
      { from: 'yc', to: 'you', value: f.yourCorpses[0] }, { from: 'yc', to: 'opp', value: f.yourCorpses[1] },
      { from: 'yc', to: 'left', value: Math.max(0, f.droppedYou - f.yourCorpses[0] - f.yourCorpses[1]) },
      { from: 'tc', to: 'you', value: f.theirCorpses[0] }, { from: 'tc', to: 'opp', value: f.theirCorpses[1] },
      { from: 'tc', to: 'left', value: Math.max(0, f.droppedOpp - f.theirCorpses[0] - f.theirCorpses[1]) },
    ]);

  const pick = (kA, kB) => [(x) => (x.side === 0 ? x.g.timeline[kA] : x.g.timeline[kB]), (x) => (x.side === 0 ? x.g.timeline[kB] : x.g.timeline[kA])];
  const drawSeries = (host, kA, kB, height, label) => {
    const [py, po] = pick(kA, kB);
    const sy = seriesStats(sel, py), so = seriesStats(sel, po);
    roundsChart(host, [
      { name: 'You', values: sy.mean, band: { lo: sy.p25, hi: sy.p75 }, cls: 'you', decimals: 1 },
      { name: 'Opponents', values: so.mean, band: { lo: so.p25, hi: so.p75 }, cls: 'opp', decimals: 1 },
    ], { height, label, nAt: (i) => `${plural(sy.n[i] || 0, 'game')} still going` });
  };
  drawSeries($('#len-chart'), 'lenA', 'lenB', 260, 'Total length by round');
  const lead = leadStats(sel);
  roundsChart($('#lead-chart'), [
    { name: 'Ahead', values: lead.ahead, cls: 'you', decimals: 0 },
    { name: 'Behind', values: lead.behind, cls: 'opp', decimals: 0 },
  ], { height: 200, label: 'Share of games ahead by round', nAt: (i) => `${plural(lead.going[i] || 0, 'game')} going`, max: 100, suffix: '%' });
  const cps = lead.checkpoints.filter((c) => c.ahead + c.behind >= 3);
  $('#lead-table').innerHTML = cps.length ? `<table>
    <thead><tr><th>At round</th><th class="num">Ahead, then won</th><th class="num">Behind, then won</th></tr></thead>
    <tbody>${cps.map((c) => `<tr><td class="num" style="text-align:left">${c.r}</td>
      <td class="num">${c.ahead ? `<b>${pct(c.aheadWon / c.ahead)}</b> <span class="muted">of ${c.ahead}</span>` : '<span class="muted">–</span>'}</td>
      <td class="num">${c.behind ? `<b>${pct(c.behindWon / c.behind)}</b> <span class="muted">of ${c.behind}</span>` : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody></table>
    <p class="muted" style="font-size:13px;margin-top:10px">A big gap between the columns means the early game decides these matches; a small one means comebacks are common.</p>` : '<p class="muted">Not enough games reach these rounds yet.</p>';
  drawSeries($('#count-chart'), 'countA', 'countB', 170, 'Dragons alive by round');
  drawSeries($('#eat-chart'), 'eatA', 'eatB', 170, 'Pearls eaten by round');

  $$('tr[data-href]').forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }; });
  return {};
}

function breakdownTable(map, kind) {
  const rows = [...map.values()].sort((a, b) => b.n - a.n);
  return `<div class="table-wrap"><table>
    <thead><tr><th>${kind === 'map' ? 'Map' : kind === 'bot' ? 'Your bot' : 'Opponent'}</th><th class="num">Games</th><th>Won</th>
      <th class="num">Pearls eaten</th><th class="num">Dragons lost</th><th class="num">Kills</th><th class="num">Self-inflicted</th><th class="num">Final length</th>${kind === 'map' ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => {
      const w = r.win / r.n;
      return `<tr ${kind === 'map' ? `class="link" data-href="#/maps/${encodeURIComponent(r.key)}"` : ''}>
        <td>${kind === 'map' ? `<span class="chart-name" style="font-size:17px">${esc(r.label)}</span> <span class="muted">${r.map.width}×${r.map.height}</span>` : esc(r.label)}</td>
        <td class="num">${fmt(r.n)}</td>
        <td><span class="rate"><span class="track"><div style="width:${w * 100}%"></div></span><span class="num">${pct(w)}</span></span></td>
        <td class="num"><span class="you-ink">${fmt(r.youEat / r.n, 1)}</span> <span class="muted">vs</span> <span class="opp-ink">${fmt(r.oppEat / r.n, 1)}</span></td>
        <td class="num"><span class="you-ink">${fmt(r.youLost / r.n, 1)}</span> <span class="muted">vs</span> <span class="opp-ink">${fmt(r.oppLost / r.n, 1)}</span></td>
        <td class="num"><span class="you-ink">${fmt(r.youKills / r.n, 1)}</span> <span class="muted">vs</span> <span class="opp-ink">${fmt(r.oppKills / r.n, 1)}</span></td>
        <td class="num">${pct(r.youSelf / Math.max(1, r.youLost))}</td>
        <td class="num"><span class="you-ink">${fmt(r.youFinal / r.n, 0)}</span> <span class="muted">vs</span> <span class="opp-ink">${fmt(r.oppFinal / r.n, 0)}</span></td>
        ${kind === 'map' ? `<td><a href="#/maps/${encodeURIComponent(r.key)}">Heatmaps</a></td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function emptyFiltered() {
  return `<div class="empty"><h2>No games match</h2><p style="margin-top:8px">Nothing loaded fits these filters and this choice of which side is you. Clear the filters, or pick a different "You are" option.</p></div>`;
}

// ---------------------------------------------------------------------------
// maps
// ---------------------------------------------------------------------------
const LAYERS = [
  { id: 'territory', label: 'Territory', help: 'Where your bodies spent more time than theirs (blue) or less (orange).' },
  { id: 'body-you', label: 'Your bodies', help: 'Rounds a segment of yours sat on each cell.' },
  { id: 'body-opp', label: 'Their bodies', help: 'Rounds a segment of theirs sat on each cell.' },
  { id: 'head-you', label: 'Your heads', help: 'Every step your heads took.' },
  { id: 'head-opp', label: 'Their heads', help: 'Every step their heads took.' },
  { id: 'eat-you', label: 'You eat', help: 'Pearls you ate, by cell.' },
  { id: 'eat-opp', label: 'They eat', help: 'Pearls they ate, by cell.' },
  { id: 'deaths-you', label: 'You die', help: 'Where your dragons died. For collisions, the cell they ran into.' },
  { id: 'deaths-opp', label: 'They die', help: 'Where their dragons died.' },
  { id: 'kills-you', label: 'You kill', help: 'Where enemy dragons died on your body or in a head-on with you.' },
  { id: 'beds', label: 'Pearl beds', help: 'Each bed shaded by who ate more of its pearls.' },
];

function viewMaps(key) {
  const sel = currentSelection();
  if (!sel.length) { main.innerHTML = emptyFiltered(); return {}; }
  const maps = new Map();
  for (const x of sel) { const m = maps.get(x.g.map.key) || { key: x.g.map.key, name: x.g.map.name, n: 0, win: 0, map: x.g.map }; m.n++; if (x.res === 'win') m.win++; maps.set(m.key, m); }
  const list = [...maps.values()].sort((a, b) => b.n - a.n);
  if (!key || !maps.has(key)) key = (S.filters.map !== 'all' && maps.has(S.filters.map)) ? S.filters.map : list[0].key;
  const m = maps.get(key);
  const geom = S.geoms.get(key);
  const games = sel.filter((x) => x.g.map.key === key);
  const mv = S.mapView;
  const canFlip = geom.symmetry !== 'none';

  main.innerHTML = `
    <div class="map-pick" role="group" aria-label="Map">${list.map((x) => `<button class="map-chip" data-key="${esc(x.key)}" aria-pressed="${x.key === key}"><span class="chart-name">${esc(x.name)}</span><small>${x.n} ${x.n === 1 ? 'game' : 'games'}, ${pct(x.win / x.n)} won</small></button>`).join('')}</div>
    <div class="layer-bar">
      <div class="seg-ctl" role="group" aria-label="Layer">${LAYERS.map((l) => `<button data-layer="${l.id}" aria-pressed="${l.id === mv.layer}">${l.label}</button>`).join('')}</div>
    </div>
    <div class="layer-bar">
      <label class="check" title="${canFlip ? '' : 'This map has no symmetry, so games cannot be mirrored'}"><input type="checkbox" id="flip" ${mv.flip && canFlip ? 'checked' : ''} ${canFlip ? '' : 'disabled'}> Mirror games so you always start on the same side</label>
      <label class="check" id="phase-wrap" hidden>When <select class="plain" id="phase-filter">${[['all', 'Any round'], ['open', 'Rounds 0–99'], ['mid', 'Rounds 100–299'], ['end', 'Round 300 on']].map(([v, l]) => `<option value="${v}" ${mv.phase === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="check" id="cause-wrap" hidden>Cause <select class="plain" id="cause-filter"><option value="all">Any cause</option>${CAUSES.map((c) => `<option value="${c}" ${mv.causes === c ? 'selected' : ''}>${CAUSE_LABEL[c]}</option>`).join('')}<option value="self" ${mv.causes === 'self' ? 'selected' : ''}>Any self-inflicted</option><option value="enemy" ${mv.causes === 'enemy' ? 'selected' : ''}>Any enemy-inflicted</option></select></label>
    </div>
    <div class="board-wrap">
      <div>
        <div id="map-board"></div>
      </div>
      <aside class="inspector">
        <div><h2 class="chart-name" style="font-size:28px;font-weight:400">${esc(m.name)}</h2><p class="muted">${geom.width} by ${geom.height}, ${geom.symmetry === 'none' ? 'no symmetry' : `${geom.symmetry === 'xy' ? 'point' : 'mirror'} symmetry`}; ${plural(games.length, 'game')}</p>
          <button class="btn" id="edit-map" type="button" style="margin-top:8px">Open in map editor</button></div>
        <p id="layer-help" class="ink2"></p>
        <div id="ramp"></div>
        <div id="cell-info" class="muted">Point at a cell for its numbers.</div>
        <div class="chart-key">
          <span><i style="border-color:var(--kelp)"></i>Kelp</span>
          <span><i style="border-color:var(--portal)"></i>Portal (numbered pairs)</span>
          <span><svg width="18" height="12" aria-hidden="true"><circle cx="9" cy="6" r="4" fill="none" stroke="var(--chart-bed)" stroke-width="1.5"/></svg>Pearl bed; larger spawns faster</span>
          <span><i style="border-color:var(--you);border-top-style:dashed"></i>Your start</span>
          <span><i style="border-color:var(--opp);border-top-style:dashed"></i>Their start</span>
        </div>
        ${!canFlip ? '<p class="note">This map has no symmetry, so games where you were team B are shown as played rather than mirrored.</p>' : ''}
      </aside>
    </div>`;

  $$('.map-chip').forEach((b) => { b.onclick = () => { location.hash = `#/maps/${encodeURIComponent(b.dataset.key)}`; }; });
  $('#edit-map').onclick = async () => { const e = await addFromGeometry(geom, m.name); location.hash = `#/editor/${e.id}`; };
  let info = null;
  const board = new Board($('#map-board'), geom, {
    label: `Heatmap of ${m.name}; the panel beside it describes the selected layer`,
    maxHeight: Math.max(420, innerHeight - 250),
    onHover: (cell) => showCell(cell),
  });

  function compute() {
    const flip = mv.flip && canFlip;
    const causes = mv.causes === 'all' ? null : mv.causes === 'self' ? new Set(CAUSES.filter((c) => !ENEMY_CAUSES.has(c))) : mv.causes === 'enemy' ? ENEMY_CAUSES : new Set([mv.causes]);
    const L = mv.layer;
    $('#cause-wrap').hidden = !(L.startsWith('deaths') || L.startsWith('kills'));
    $('#phase-wrap').hidden = $('#cause-wrap').hidden;
    const [fromRound, toRound] = { all: [0, 9999], open: [0, 99], mid: [100, 299], end: [300, 9999] }[mv.phase || 'all'];
    $('#layer-help').textContent = LAYERS.find((l) => l.id === L).help;
    const flipTeams = false;
    let layer = null, bedShare = null, extra = {};
    if (L === 'territory') {
      const a = mapLayer(games, geom, { layer: 'body', who: 'you', flip }), b = mapLayer(games, geom, { layer: 'body', who: 'opp', flip });
      const v = new Float32Array(a.values.length), w = new Float32Array(a.values.length);
      for (let i = 0; i < v.length; i++) {
        const t = a.values[i] + b.values[i];
        w[i] = t / Math.max(1, games.length);
        v[i] = t ? (a.values[i] - b.values[i]) / t : 0;
      }
      layer = { values: v, weight: w, kind: 'share' };
      extra = { you: a.values, opp: b.values };
    } else if (L === 'beds') {
      const a = mapLayer(games, geom, { layer: 'eat', who: 'you', flip }), b = mapLayer(games, geom, { layer: 'eat', who: 'opp', flip });
      bedShare = new Float32Array(a.values.length);
      for (let i = 0; i < bedShare.length; i++) { const t = a.values[i] + b.values[i]; bedShare[i] = t ? (a.values[i] - b.values[i]) / t : 0; }
      extra = { you: a.values, opp: b.values };
    } else {
      const [kind, who] = L.split('-');
      const r = mapLayer(games, geom, { layer: kind, who, flip, causes, fromRound, toRound });
      const v = new Float32Array(r.values.length);
      for (let i = 0; i < v.length; i++) v[i] = r.values[i] / Math.max(1, games.length);
      layer = { values: v, kind: who === 'you' ? 'you' : 'opp' };
      extra = { raw: r.values };
    }
    info = { layer, extra, L, flip };
    board.set({ layer, bedShare, flipTeams, showSpawns: true });
    drawRamp(layer, L);
  }
  function drawRamp(layer, L) {
    const host = $('#ramp');
    if (L === 'beds') {
      host.innerHTML = `<div class="ramp">${rampCss('opp', isDark(), 6).reverse().map((c) => `<div style="background:${c}"></div>`).join('')}${rampCss('you', isDark(), 6).map((c) => `<div style="background:${c}"></div>`).join('')}</div><div class="ramp-labels"><span>They ate all</span><span>Even</span><span>You ate all</span></div>`;
      return;
    }
    if (!layer) { host.innerHTML = ''; return; }
    const top = scaleTop(layer.values);
    if (layer.kind === 'share') {
      host.innerHTML = `<div class="ramp">${rampCss('opp', isDark(), 6).reverse().map((c) => `<div style="background:${c}"></div>`).join('')}${rampCss('you', isDark(), 6).map((c) => `<div style="background:${c}"></div>`).join('')}</div><div class="ramp-labels"><span>All theirs</span><span>Even</span><span>All yours</span></div><p class="muted" style="font-size:12.5px;margin-top:4px">Colour is your share of the time dragons spent on the cell; faint cells are rarely visited.</p>`;
    } else if (layer.kind === 'diverge') {
      host.innerHTML = `<div class="ramp">${rampCss('opp', isDark(), 6).reverse().map((c) => `<div style="background:${c}"></div>`).join('')}${rampCss('you', isDark(), 6).map((c) => `<div style="background:${c}"></div>`).join('')}</div><div class="ramp-labels"><span>Theirs +${fmt(top, 1)}</span><span>Even</span><span>Yours +${fmt(top, 1)}</span></div>`;
    } else {
      host.innerHTML = `<div class="ramp">${rampCss(layer.kind, isDark(), 10).map((c) => `<div style="background:${c}"></div>`).join('')}</div><div class="ramp-labels"><span>0</span><span>${fmt(top, top < 1 ? 2 : 1)}+ a game</span></div>`;
    }
  }
  function showCell(cell) {
    const box = $('#cell-info');
    if (cell == null) { box.innerHTML = 'Point at a cell for its numbers.'; box.className = 'muted'; return; }
    const x = cell % geom.width, y = (cell - x) / geom.width;
    const rows = [];
    const g = games.length || 1;
    if (info.L === 'territory' || info.L === 'beds') {
      const label = info.L === 'beds' ? 'pearls a game' : 'rounds a game';
      const yv = info.extra.you[cell], ov = info.extra.opp[cell];
      rows.push(['You', `${fmt(yv / g, 1)} ${label}`], ['Them', `${fmt(ov / g, 1)} ${label}`]);
      if (yv + ov) rows.push(['Your share', pct(yv / (yv + ov))]);
    } else if (info.layer) rows.push(['This layer', `${fmt(info.layer.values[cell], 2)} a game`], ['All games', fmt(info.extra.raw[cell])]);
    if (geom.beds[cell]) rows.push(['Pearl bed', `every ${geom.bedMin[cell]}–${geom.bedMax[cell]} rounds`]);
    box.className = '';
    box.innerHTML = `<div class="cell-h">Cell ${x}, ${y}</div><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }
  $$('.layer-bar [data-layer]').forEach((b) => { b.onclick = () => { mv.layer = b.dataset.layer; $$('.layer-bar [data-layer]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); compute(); }; });
  $('#flip').onchange = (e) => { mv.flip = e.target.checked; compute(); };
  $('#cause-filter').onchange = (e) => { mv.causes = e.target.value; compute(); };
  $('#phase-filter').onchange = (e) => { mv.phase = e.target.value; compute(); };
  compute();
  return { cleanup: () => board.destroy() };
}

// ---------------------------------------------------------------------------
// games list
// ---------------------------------------------------------------------------
function viewGames() {
  const sel = currentSelection();
  if (!sel.length) { main.innerHTML = emptyFiltered(); return {}; }
  const sortState = S.gamesSort ||= { key: 'uid', dir: 1 };
  const cols = [
    ['uid', 'File', (x) => x.path.toLowerCase(), false],
    ['map', 'Map', (x) => x.g.map.name, false],
    ['res', 'Result', (x) => ({ win: 0, draw: 1, loss: 2 }[x.res]), false],
    ['rounds', 'Rounds', (x) => x.g.rounds, true],
    ['len', 'Final length', (x) => x.g.teams[x.side].finalTotal - x.g.teams[1 - x.side].finalTotal, true],
    ['eat', 'Pearls eaten', (x) => x.g.teams[x.side].eaten, true],
    ['lost', 'Dragons lost', (x) => x.g.teams[x.side].lost, true],
    ['kills', 'Kills', (x) => x.g.teams[x.side].kills, true],
    ['self', 'Self-inflicted', (x) => selfInflicted(x.g.teams[x.side], 'lenLostBy') / Math.max(1, x.g.teams[x.side].lenLost), true],
  ];
  const render = () => {
    const col = cols.find((c) => c[0] === sortState.key) || cols[0];
    const rows = [...sel].sort((a, b) => { const va = col[2](a), vb = col[2](b); return (va < vb ? -1 : va > vb ? 1 : 0) * sortState.dir; });
    main.innerHTML = `
      <div class="page-head"><div><div class="headline">${plural(sel.length, 'game')}</div><p class="subline">Open one to replay it with every death, pearl and split marked.</p></div><button class="btn" id="csv" type="button" style="margin-left:auto">Download as CSV</button></div>
      <div class="table-wrap"><table id="games">
        <thead><tr>${cols.map((c) => `<th class="sortable${c[3] ? ' num' : ''}" data-k="${c[0]}" aria-sort="${c[0] === sortState.key ? (sortState.dir > 0 ? 'ascending' : 'descending') : 'none'}" tabindex="0">${c[1]}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 2000).map((x) => {
          const t = x.g.teams[x.side], o = x.g.teams[1 - x.side];
          return `<tr class="link" data-uid="${x.uid}">
            <td><a href="#/game/${x.uid}">${esc(x.path.length > 60 ? `…${x.path.slice(-58)}` : x.path)}</a></td>
            <td><span class="chart-name" style="font-size:16px">${esc(x.g.map.name)}</span></td>
            <td><span class="res ${x.res}">${x.res === 'win' ? 'Won' : x.res === 'loss' ? 'Lost' : 'Draw'}</span> <span class="muted">${x.g.endReason === 'teamEliminated' ? 'elimination' : 'on length'}</span></td>
            <td class="num">${x.g.rounds}</td>
            <td class="num"><span class="you-ink">${t.finalTotal}</span> <span class="muted">vs</span> <span class="opp-ink">${o.finalTotal}</span></td>
            <td class="num"><span class="you-ink">${t.eaten}</span> <span class="muted">vs</span> <span class="opp-ink">${o.eaten}</span></td>
            <td class="num"><span class="you-ink">${t.lost}</span> <span class="muted">vs</span> <span class="opp-ink">${o.lost}</span></td>
            <td class="num"><span class="you-ink">${t.kills}</span> <span class="muted">vs</span> <span class="opp-ink">${o.kills}</span></td>
            <td class="num">${pct(selfInflicted(t, 'lenLostBy') / Math.max(1, t.lenLost))}</td>
          </tr>`;
        }).join('')}</tbody></table></div>
      ${rows.length > 2000 ? `<p class="muted" style="margin-top:10px">Showing the first 2,000 of ${fmt(rows.length)}. Filter to narrow it down.</p>` : ''}`;
    $$('#games th').forEach((th) => {
      const go = () => { if (sortState.key === th.dataset.k) sortState.dir *= -1; else { sortState.key = th.dataset.k; sortState.dir = cols.find((c) => c[0] === th.dataset.k)[3] ? -1 : 1; } render(); };
      th.onclick = go;
      th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    $$('#games tbody tr').forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('a')) location.hash = `#/game/${tr.dataset.uid}`; }; });
    $('#csv').onclick = () => downloadCsv(rows);
  };
  render();
  return {};
}

function downloadCsv(rows) {
  const cols = [
    ['file', (x) => x.path], ['map', (x) => x.g.map.name], ['result', (x) => x.res], ['end', (x) => x.g.endReason], ['rounds', (x) => x.g.rounds],
    ['your_bot', (x) => x.you], ['opponent', (x) => x.opp],
  ];
  for (const [key, side] of [['you', (x) => x.side], ['opp', (x) => 1 - x.side]]) {
    const t = (x) => x.g.teams[side(x)];
    cols.push([`${key}_final_length`, (x) => t(x).finalTotal], [`${key}_longest`, (x) => t(x).finalLongest], [`${key}_dragons`, (x) => t(x).finalDragons],
      [`${key}_eaten`, (x) => t(x).eaten], [`${key}_eaten_natural`, (x) => t(x).eatenNatural], [`${key}_eaten_enemy_corpse`, (x) => t(x).eatenEnemyCorpse],
      [`${key}_eaten_own_corpse`, (x) => t(x).eatenOwnCorpse], [`${key}_dragons_lost`, (x) => t(x).lost], [`${key}_length_lost`, (x) => t(x).lenLost],
      [`${key}_kills`, (x) => t(x).kills], [`${key}_kill_length`, (x) => t(x).killLen], [`${key}_splits`, (x) => t(x).splits], [`${key}_sprints`, (x) => t(x).sprints]);
    for (const c of CAUSES) cols.push([`${key}_length_lost_${c}`, (x) => t(x).lenLostBy[c]]);
  }
  const cell = (v) => { const str = String(v ?? ''); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; };
  const csv = [cols.map((c) => c[0]).join(','), ...rows.map((x) => cols.map((c) => cell(c[1](x))).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'soundings-games.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// one game
// ---------------------------------------------------------------------------
async function loadDetail(x) {
  if (S.detail.has(x.uid)) return S.detail.get(x.uid);
  const p = (async () => {
    const bytes = await x.src.read();
    return pool.run(bytes, true);
  })();
  S.detail.set(x.uid, p);
  if (S.detail.size > 6) S.detail.delete(S.detail.keys().next().value);
  return p;
}

function viewGame(uid) {
  const x0 = S.games.find((g) => g.uid === uid);
  if (!x0) { main.innerHTML = '<div class="empty"><h2>That game isn\'t loaded</h2><p>Reloading the page clears loaded replays. Open them again to continue.</p></div>'; return {}; }
  const popular = botPopularity(S.games);
  let side = resolveSide(x0.g, S.perspective, popular);
  if (side < 0) side = 0;
  const x = { ...x0, side, res: outcome(x0.g, side) };
  main.innerHTML = `<p class="muted">Rebuilding ${esc(x.name)}…</p>`;
  let alive = true;
  let cleanupFns = [];
  loadDetail(x).then((d) => { if (alive) renderGame(x, d, (fn) => cleanupFns.push(fn)); })
    .catch((err) => { if (alive) main.innerHTML = `<div class="empty"><h2>Couldn't rebuild this game</h2><p>${esc(err.message)}</p></div>`; });
  return { soft: false, cleanup: () => { alive = false; cleanupFns.forEach((f) => f()); } };
}

function renderGame(x, d, onCleanup) {
  const s = x.side, o = 1 - s;
  const T = d.teams, youT = T[s], oppT = T[o];
  const geom = S.geoms.get(d.map.key) || { ...d.mapData, portals: d.mapData.portalOf, spawns: d.mapData.dragons };
  const R = d.rounds;
  const youName = botLabel(s === 0 ? d.botA : d.botB), oppName = botLabel(s === 0 ? d.botB : d.botA);
  const tl = d.timeline;
  const series = (a, b) => (s === 0 ? [tl[a], tl[b]] : [tl[b], tl[a]]);
  const [lenY, lenO] = series('lenA', 'lenB'), [cntY, cntO] = series('countA', 'countB'), [eatY, eatO] = series('eatA', 'eatB');
  const [longY, longO] = series('longA', 'longB');
  const events = [];
  for (const dd of d.deaths) events.push({ r: dd.r, kind: 'death', d: dd });
  for (let i = 0; i < d.splits.length; i += 6) events.push({ r: d.splits[i], kind: 'split', team: d.splits[i + 2], len: d.splits[i + 3], cell: d.splits[i + 1] });
  events.sort((a, b) => a.r - b.r);
  const moments = [];
  if (d.firstBlood) moments.push({ r: d.firstBlood.round, label: 'First blood' });
  if (d.leadChanges) moments.push({ r: d.decisiveRound, label: 'Last lead change' });

  main.innerHTML = `
    <div class="game-head">
      <div><span class="chart-name">${esc(d.map.name)}</span><div class="muted" style="margin-top:6px">${esc(x.path)}</div></div>
      <div><span class="res ${x.res}">${x.res === 'win' ? 'Won' : x.res === 'loss' ? 'Lost' : 'Draw'}</span> <span class="ink2">${d.endReason === 'teamEliminated' ? `by elimination in round ${R - 1}` : 'on length after 500 rounds'}</span></div>
      <div class="vs"><b class="you-ink">${esc(youName)}</b> <span class="muted">vs</span> <b class="opp-ink">${esc(oppName)}</b></div>
    </div>
    <div class="player">
      <div>
        <div id="g-board"></div>
        <div class="transport">
          <button class="btn" id="play" type="button" aria-label="Play">Play</button>
          <input type="range" id="scrub" min="0" max="${R - 1}" value="0" aria-label="Round">
          <span class="round" id="round-label"></span>
          <select class="plain" id="speed" aria-label="Speed"><option value="4">4 rounds/s</option><option value="10" selected>10 rounds/s</option><option value="25">25 rounds/s</option><option value="60">60 rounds/s</option></select>
          <select class="plain" id="overlay" aria-label="Heat overlay"><option value="">No heat</option><option value="body-you">Your bodies</option><option value="body-opp">Their bodies</option><option value="head-you">Your heads</option><option value="head-opp">Their heads</option></select>
        </div>
      </div>
      <aside class="scoreboard">
        <div class="score-row"><span></span><span class="muted">alive</span><span class="muted">length</span><span class="muted">longest</span></div>
        <div class="score-row"><span class="you-ink">${esc(youName)}</span><b id="sc-yc"></b><b id="sc-yl"></b><b id="sc-yg"></b></div>
        <div class="score-row"><span class="opp-ink">${esc(oppName)}</span><b id="sc-oc"></b><b id="sc-ol"></b><b id="sc-og"></b></div>
        <p class="muted" id="sc-extra" style="font-size:13px"></p>
        <h3 style="margin-top:6px">Deaths and splits</h3>
        <div class="feed" id="feed"></div>
      </aside>
    </div>

    <section class="section">
      <header><h2>Over the game</h2><p>Click a chart to jump there.</p></header>
      <div class="legend"><span><i class="key you"></i>${esc(youName)}</span><span><i class="key opp"></i>${esc(oppName)}</span><span><i class="key you" style="opacity:.5"></i>Longest dragon, dashed</span></div>
      <div id="g-len"></div>
      <div class="cols" style="margin-top:16px"><div><h3>Dragons alive</h3><div id="g-cnt"></div></div><div><h3>Pearls eaten so far</h3><div id="g-eat"></div></div></div>
    </section>

    <section class="section">
      <header><h2>How each side died</h2><p>${plural(youT.lost, 'dragon')} of yours and ${plural(oppT.lost, 'dragon')} of theirs.</p></header>
      <div class="cols-2-1">
        <div id="g-causes"></div>
        <div class="figures">
          <div class="figure"><div class="k">Self-inflicted length</div><div class="v"><span class="you-ink">${pct(selfInflicted(youT, 'lenLostBy') / Math.max(1, youT.lenLost))}</span> <small>vs</small> <span class="opp-ink">${pct(selfInflicted(oppT, 'lenLostBy') / Math.max(1, oppT.lenLost))}</span></div></div>
          <div class="figure"><div class="k">Enemies killed</div><div class="v"><span class="you-ink">${youT.kills}</span> <small>vs</small> <span class="opp-ink">${oppT.kills}</span></div><div class="s">${youT.bodyKills} ran into your body, ${youT.headKills} head-on</div></div>
          <div class="figure"><div class="k">Pearls eaten</div><div class="v"><span class="you-ink">${youT.eaten}</span> <small>vs</small> <span class="opp-ink">${oppT.eaten}</span></div><div class="s">${youT.eatenEnemyCorpse} of yours from their corpses</div></div>
          <div class="figure"><div class="k">Splits</div><div class="v"><span class="you-ink">${youT.splits}</span> <small>vs</small> <span class="opp-ink">${oppT.splits}</span></div></div>
        </div>
      </div>
    </section>

    <section class="section">
      <header><h2>Lifelines</h2><p>Every dragon from birth to death, grouped by side. Thickness is length; a split draws a thin link from parent to child; the end mark is coloured by cause of death.</p></header>
      <div id="g-life" class="lifelines"></div>
    </section>

    <section class="section">
      <header><h2>Pearls</h2></header>
      <div id="g-flow"></div>
    </section>
    ${youT.measuredTurns ? `<section class="section"><header><h2>Compute</h2><p>Instructions per turn for your dragons (the server only keeps these for the side that downloaded the replay).</p></header><div id="g-instr"></div><p class="muted" style="margin-top:8px">${fmt(youT.measuredTurns)} measured turns, ${fmtPow(youT.instrSum / youT.measuredTurns)} instructions on average, peak ${fmtPow(youT.instrMax)}; ${youT.tle} timeouts, ${youT.exceeded} over budget.</p></section>` : ''}
    ${d.logs && d.logs.length ? `<section class="section"><header><h2>Bot output</h2><p>${plural(d.logs.length, 'line')} of logs and indicators kept in this replay.</p><input class="aside" id="log-q" type="search" placeholder="Filter logs" style="border:1px solid var(--rule-strong);border-radius:6px;padding:5px 9px;background:var(--surface)"></header><div class="feed" id="g-logs" style="max-height:360px"></div></section>` : ''}`;

  // Board player.
  const board = new Board($('#g-board'), geom, { maxHeight: Math.max(380, innerHeight - 260), label: 'The board at the selected round; the scoreboard beside it gives the numbers' });
  board.flipTeams = s === 1;
  board.showSpawns = false;
  onCleanup(() => board.destroy());
  let r = 0, playing = false, timer = null;
  const feed = $('#feed');
  feed.innerHTML = events.slice(0, 3000).map((ev, i) => {
    const mine = (ev.kind === 'death' ? ev.d.team : ev.team) === s;
    const who = `<span class="${mine ? 'you-ink' : 'opp-ink'}">${mine ? 'Yours' : 'Theirs'}</span>`;
    const what = ev.kind === 'death' ? `${who}, length ${ev.d.len}: <span class="swatch c-${ev.d.cause}"></span>${esc(CAUSE_LABEL[ev.d.cause].toLowerCase())}` : `${who} split off ${ev.len}`;
    return `<div data-r="${ev.r}" data-i="${i}"><span class="r">${ev.r}</span><span>${what}</span></div>`;
  }).join('') || '<p class="muted" style="padding:8px 0">No deaths or splits.</p>';
  feed.onclick = (e) => { const row = e.target.closest('[data-r]'); if (row) seek(Number(row.dataset.r)); };
  const overlaySel = $('#overlay');
  const heatOf = (v) => {
    if (!v) return null;
    const [kind, who] = v.split('-');
    const team = who === 'you' ? s : o;
    const src = d.heat[kind][team];
    return { values: Float32Array.from(src), kind: who === 'you' ? 'you' : 'opp' };
  };
  overlaySel.onchange = () => { board.layer = heatOf(overlaySel.value); show(); };
  const show = () => {
    board.dragons = d.snaps.bodies[r];
    board.pearls = d.snaps.pearls[r];
    board.marks = d.deaths.filter((dd) => dd.r === r).map((dd) => ({ cell: dd.cell, color: getComputedStyle(document.documentElement).getPropertyValue(`--c-${dd.cause}`).trim(), size: 0.36 }));
    board.draw();
    $('#scrub').value = r;
    $('#round-label').textContent = `Round ${r} of ${R - 1}`;
    $('#sc-yc').textContent = cntY[r]; $('#sc-yl').textContent = lenY[r]; $('#sc-yg').textContent = longY[r];
    $('#sc-oc').textContent = cntO[r]; $('#sc-ol').textContent = lenO[r]; $('#sc-og').textContent = longO[r];
    $('#sc-extra').textContent = `Pearls eaten so far: ${eatY[r]} yours, ${eatO[r]} theirs. ${d.timeline.pearls[r]} on the board.`;
    for (const id of ['#g-len', '#g-cnt', '#g-eat']) $(id)?._setCursor?.(r);
    const near = [...feed.children].find((c) => Number(c.dataset.r) >= r);
    if (near) feed.scrollTop = near.offsetTop - feed.offsetTop - 4;
    for (const c of feed.querySelectorAll('.now')) c.classList.remove('now');
    for (const c of feed.querySelectorAll(`[data-r="${r}"]`)) c.classList.add('now');
  };
  const seek = (nr) => { r = Math.max(0, Math.min(R - 1, nr)); show(); };
  const stop = () => { playing = false; clearInterval(timer); $('#play').textContent = 'Play'; };
  const play = () => {
    if (r >= R - 1) r = 0;
    playing = true; $('#play').textContent = 'Pause';
    clearInterval(timer);
    timer = setInterval(() => { if (r >= R - 1) { stop(); return; } seek(r + 1); }, 1000 / Number($('#speed').value));
  };
  $('#play').onclick = () => (playing ? stop() : play());
  $('#speed').onchange = () => { if (playing) play(); };
  $('#scrub').oninput = (e) => { stop(); seek(Number(e.target.value)); };
  const keys = (e) => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === 'ArrowRight') { stop(); seek(r + (e.shiftKey ? 10 : 1)); }
    else if (e.key === 'ArrowLeft') { stop(); seek(r - (e.shiftKey ? 10 : 1)); }
  };
  addEventListener('keydown', keys);
  onCleanup(() => { stop(); removeEventListener('keydown', keys); });

  const markers = moments.map((m) => ({ x: m.r, label: m.label }));
  roundsChart($('#g-len'), [
    { name: 'Your total', values: lenY, cls: 'you' }, { name: 'Their total', values: lenO, cls: 'opp' },
    { name: 'Your longest', values: longY, cls: 'you', dashed: true }, { name: 'Their longest', values: longO, cls: 'opp', dashed: true },
  ], { height: 250, markers, onPick: (i) => { stop(); seek(i); }, cursor: 0 });
  roundsChart($('#g-cnt'), [{ name: 'Yours', values: cntY, cls: 'you' }, { name: 'Theirs', values: cntO, cls: 'opp' }], { height: 160, onPick: (i) => { stop(); seek(i); }, cursor: 0 });
  roundsChart($('#g-eat'), [{ name: 'Yours', values: eatY, cls: 'you' }, { name: 'Theirs', values: eatO, cls: 'opp' }], { height: 160, onPick: (i) => { stop(); seek(i); }, cursor: 0 });

  butterfly($('#g-causes'), CAUSES.filter((c) => youT.lostBy[c] || oppT.lostBy[c]).map((c) => ({
    label: CAUSE_LABEL[c], you: youT.lenLostBy[c], opp: oppT.lenLostBy[c], cls: `c-${c}`, swatch: true,
    note: `${youT.lostBy[c]} of yours, ${oppT.lostBy[c]} of theirs`,
  })), { youLabel: 'Your length lost', oppLabel: 'Their length lost', decimals: 0 });

  const f = d.flow;
  flowChart($('#g-flow'),
    [{ id: 'nat', label: 'Natural beds', cls: 'c-natural' }, { id: 'yc', label: 'Your corpses', cls: 'c-you' }, { id: 'tc', label: 'Their corpses', cls: 'c-opp' }],
    [{ id: 'you', label: 'Eaten by you', cls: 'c-you' }, { id: 'opp', label: 'Eaten by them', cls: 'c-opp' }, { id: 'left', label: 'Never eaten', cls: 'c-natural' }],
    [
      { from: 'nat', to: 'you', value: f[0][s] }, { from: 'nat', to: 'opp', value: f[0][o] }, { from: 'nat', to: 'left', value: Math.max(0, f[0][2] - f[0][0] - f[0][1]) },
      { from: 'yc', to: 'you', value: f[1 + s][s] }, { from: 'yc', to: 'opp', value: f[1 + s][o] }, { from: 'yc', to: 'left', value: Math.max(0, f[1 + s][2] - f[1 + s][0] - f[1 + s][1]) },
      { from: 'tc', to: 'you', value: f[1 + o][s] }, { from: 'tc', to: 'opp', value: f[1 + o][o] }, { from: 'tc', to: 'left', value: Math.max(0, f[1 + o][2] - f[1 + o][0] - f[1 + o][1]) },
    ]);

  lifelines($('#g-life'), d.dragons, R, s, (i) => { stop(); seek(i); scrollTo({ top: 0, behavior: 'smooth' }); });

  if (youT.measuredTurns) {
    const hist = youT.instrHist;
    const last = hist.reduce((m, v, i) => (v ? i : m), 0);
    columns($('#g-instr'), hist.slice(0, last + 1).map((v, i) => ({
      label: i % 2 ? '' : `${fmtPow(2 ** (i + 8))}`, value: v, cls: 'you',
      tip: `${fmt(v)} turns used ${fmtPow(2 ** (i + 8))}–${fmtPow(2 ** (i + 9))} instructions`,
    })));
  }
  if (d.logs && d.logs.length) {
    const box = $('#g-logs');
    const draw = (q) => {
      const ql = q.trim().toLowerCase();
      const rows = d.logs.filter((l) => !ql || l.text.toLowerCase().includes(ql)).slice(0, 1500);
      box.innerHTML = rows.map((l) => `<div data-r="${l.r}"><span class="r">${l.r}</span><span class="muted">#${l.id}</span><span>${esc(l.text.slice(0, 300))}</span></div>`).join('') || '<p class="muted">No lines match.</p>';
    };
    draw('');
    $('#log-q').oninput = (e) => draw(e.target.value);
    box.onclick = (e) => { const row = e.target.closest('[data-r]'); if (row) { stop(); seek(Number(row.dataset.r)); scrollTo({ top: 0, behavior: 'smooth' }); } };
  }
  show();
}

const fmtPow = (v) => (v >= 1e9 ? `${fmt(v / 1e9, 1)}B` : v >= 1e6 ? `${fmt(v / 1e6, v >= 1e8 ? 0 : 1)}M` : v >= 1e3 ? `${fmt(v / 1e3, 0)}k` : fmt(v));

/** Every dragon's life as a band: thickness = length, end mark = cause of death. */
function lifelines(host, dragons, R, side, onPick) {
  const NS = 'http://www.w3.org/2000/svg';
  const ordered = [...dragons].sort((a, b) => ((a.team === side ? 0 : 1) - (b.team === side ? 0 : 1)) || a.born - b.born || a.id - b.id);
  const n = ordered.length;
  const rowH = Math.min(8, 640 / Math.max(1, n));
  const maxLen = Math.max(1, ...dragons.map((d) => d.maxLen));
  const draw = () => {
    const W = Math.max(300, host.clientWidth), gapMid = 14, m = { l: 12, r: 12, t: 18, b: 22 };
    const yourCount = ordered.filter((d) => d.team === side).length;
    const H = m.t + n * rowH + gapMid + m.b;
    const X = (r) => m.l + (r / Math.max(1, R - 1)) * (W - m.l - m.r);
    const rowY = (i) => m.t + i * rowH + (i >= yourCount ? gapMid : 0) + rowH / 2;
    const parts = [];
    parts.push(`<text x="${m.l}" y="12" class="axis">Your dragons (${yourCount})</text>`);
    parts.push(`<text x="${m.l}" y="${m.t + yourCount * rowH + gapMid - 3}" class="axis">Their dragons (${n - yourCount})</text>`);
    const index = new Map(ordered.map((d, i) => [d.id, i]));
    for (let i = 0; i < n; i++) {
      const d = ordered[i], y = rowY(i), cls = d.team === side ? 'you' : 'opp';
      const end = d.died >= 0 ? d.died : R - 1;
      if (d.lens && d.lens.length > 1 && rowH >= 3) {
        const pts = [];
        for (let k = 0; k < d.lens.length; k++) pts.push([X(d.born + k), (d.lens[k] / maxLen) * (rowH * 0.95)]);
        let path = `M${pts[0][0]},${y - pts[0][1] / 2}`;
        for (const [px, th] of pts) path += `L${px.toFixed(1)},${(y - th / 2 - 0.3).toFixed(2)}`;
        for (let k = pts.length - 1; k >= 0; k--) path += `L${pts[k][0].toFixed(1)},${(y + pts[k][1] / 2 + 0.3).toFixed(2)}`;
        parts.push(`<path d="${path}Z" class="${cls}" style="fill:var(--${cls});stroke:none;opacity:.9"/>`);
      } else {
        parts.push(`<line x1="${X(d.born)}" x2="${Math.max(X(d.born) + 1, X(end))}" y1="${y}" y2="${y}" class="life ${cls}" stroke-width="${Math.max(0.8, rowH * 0.8)}"/>`);
      }
      if (d.parent >= 0 && index.has(d.parent) && rowH >= 2) {
        const py = rowY(index.get(d.parent));
        parts.push(`<path d="M${X(d.born)},${py} L${X(d.born)},${y}" class="link"/>`);
      }
      if (d.died >= 0 && rowH >= 1) parts.push(`<line x1="${X(d.died)}" x2="${X(d.died)}" y1="${y - Math.max(1.5, rowH / 2)}" y2="${y + Math.max(1.5, rowH / 2)}" class="endcap c-${d.cause}"/>`);
    }
    const ticks = [0, 100, 200, 300, 400, 499].filter((t) => t < R);
    for (const t of ticks) parts.push(`<text x="${X(t)}" y="${H - 6}" text-anchor="middle" class="axis">${t}</text>`);
    host.innerHTML = `<div class="tip"></div><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Dragon lifelines">${parts.join('')}</svg>`;
    const svg = host.querySelector('svg');
    const tip = host.querySelector('.tip');
    svg.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const py = e.clientY - rect.top, px = e.clientX - rect.left;
      let i = Math.floor((py - m.t) / rowH);
      if (i >= yourCount) i = Math.floor((py - m.t - gapMid) / rowH);
      const d = ordered[i];
      if (!d || i < 0) { tip.style.display = 'none'; return; }
      tip.innerHTML = `<div class="tip-h">Dragon ${d.id}, ${d.team === side ? 'yours' : 'theirs'}</div>Born round ${d.born}${d.parent >= 0 ? ` from ${d.parent}` : ''}<br>${d.died >= 0 ? `Died round ${d.died}: ${esc(CAUSE_LABEL[d.cause].toLowerCase())} at length ${d.lenAtDeath}` : 'Survived'}<br>Longest ${d.maxLen}, ate ${d.eaten}, ${d.kills} kills`;
      tip.style.display = 'block';
      tip.style.left = `${Math.min(px + 14, rect.width - tip.offsetWidth)}px`;
      tip.style.top = `${Math.max(0, py - 70)}px`;
    });
    svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    svg.addEventListener('click', (e) => {
      const rect = svg.getBoundingClientRect();
      onPick(Math.round(((e.clientX - rect.left - m.l) / (W - m.l - m.r)) * (R - 1)));
    });
  };
  if (host._ro) host._ro.disconnect();
  host._ro = new ResizeObserver(draw);
  host._ro.observe(host);
  draw();
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  $('#theme').onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    try { localStorage.setItem('soundings.theme', next); } catch {}
    rerender();
    if (!S.games.length) route();
  };
  setupIntake();
  addEventListener('hashchange', route);
  if (new URLSearchParams(location.search).has('dev')) {
    window.__lab = {
      S,
      async loadUrls(urls) {
        const sources = urls.map((u) => ({ kind: /\.map$/i.test(u) ? 'map' : 'replay', name: u.split('/').pop(), path: u, size: 0,
          read: async () => new Uint8Array(await (await fetch(u)).arrayBuffer()) }));
        const zips = [];
        for (const s of sources) if (/\.zip$/i.test(s.name)) zips.push(s);
        if (zips.length) {
          const { sourcesFrom: sf } = await import('./ingest.js');
          const files = await Promise.all(zips.map(async (z) => new File([await z.read()], z.name)));
          const inner = await sf({ files });
          return ingest([...sources.filter((s) => !zips.includes(s)), ...inner]);
        }
        return ingest(sources);
      },
    };
  }
  route();
}
boot();
