// Turns whatever was dropped or picked (files, folders, zips) into replay
// sources, and runs them through a pool of analysis workers.
import { isZip, listZip } from './zip.js';

const REPLAY_NAME = /\.(replay|rpl)(\.gz)?$|\.gz$/i;
const SKIP_NAME = /(^|\/)(__MACOSX\/|\._|\.DS_Store$)/;

/** A source is { name, path, size, read(): Promise<Uint8Array> }. */
async function expand(file, path, out, depth = 0) {
  if (SKIP_NAME.test(path)) return;
  if (/\.zip$/i.test(file.name) || (depth === 0 && !REPLAY_NAME.test(file.name) && await isZip(file))) {
    if (depth > 2) return;
    const entries = await listZip(file);
    for (const e of entries) {
      const inner = `${path}/${e.name}`;
      if (/\.zip$/i.test(e.name)) {
        const bytes = await e.read();
        await expand(new File([bytes], e.name), inner, out, depth + 1);
      } else if (REPLAY_NAME.test(e.name)) {
        out.push({ name: e.name.split('/').pop(), path: inner, size: e.size, read: () => e.read() });
      }
    }
    return;
  }
  // Loose files: take anything named like a replay, or anything picked on its own.
  if (REPLAY_NAME.test(file.name) || depth === 0) {
    out.push({ name: file.name, path, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) });
  }
}

function readDir(entry) {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader();
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
}

async function walkEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    await expand(file, entry.fullPath.replace(/^\//, ''), out, REPLAY_NAME.test(file.name) || /\.zip$/i.test(file.name) ? 0 : 1);
  } else if (entry.isDirectory) {
    for (const child of await readDir(entry)) await walkEntry(child, out);
  }
}

/** Sources from a drop event (keeps folder structure) or a file input. */
export async function sourcesFrom({ items, files }) {
  const out = [];
  const entries = items ? [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) : [];
  if (entries.length) {
    for (const e of entries) await walkEntry(e, out);
  } else {
    for (const f of files || []) await expand(f, f.webkitRelativePath || f.name, out, f.webkitRelativePath && !REPLAY_NAME.test(f.name) && !/\.zip$/i.test(f.name) ? 1 : 0);
  }
  return out;
}

// ---- worker pool ------------------------------------------------------------------

export class Pool {
  constructor(size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.jobs = new Map();
    this.nextId = 1;
  }

  spawn() {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const job = this.jobs.get(e.data.id);
      this.jobs.delete(e.data.id);
      this.idle.push(w);
      if (job) e.data.ok ? job.resolve(e.data.game) : job.reject(new Error(e.data.error));
      this.pump();
    };
    w.onerror = (e) => { e.preventDefault(); };
    this.workers.push(w);
    this.idle.push(w);
  }

  pump() {
    while (this.queue.length && (this.idle.length || this.workers.length < this.size)) {
      if (!this.idle.length) this.spawn();
      const w = this.idle.pop();
      const job = this.queue.shift();
      this.jobs.set(job.id, job);
      w.postMessage({ id: job.id, bytes: job.bytes, detail: job.detail }, [job.bytes]);
    }
  }

  run(bytes, detail = false) {
    const buf = bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, bytes: buf, detail, resolve, reject });
      this.pump();
    });
  }
}

/**
 * Analyse many sources with bounded memory: at most `inFlight` files are read
 * and waiting at once. Calls onGame(source, game) / onError(source, error) as
 * each finishes, in completion order.
 */
export async function analyseAll(pool, sources, { onGame, onError, signal }) {
  const inFlight = pool.size * 2;
  let next = 0;
  const runOne = async () => {
    while (next < sources.length && !signal?.aborted) {
      const src = sources[next++];
      try {
        const bytes = await src.read();
        const game = await pool.run(bytes);
        onGame(src, game);
      } catch (err) {
        onError(src, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(inFlight, sources.length) }, runOne));
}
