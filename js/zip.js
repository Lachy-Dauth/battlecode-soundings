// Minimal zip reader over a Blob: reads the central directory, then inflates
// entries on demand with the browser's own DecompressionStream.

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;

async function slice(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

export async function isZip(blob) {
  if (blob.size < 22) return false;
  const dv = await slice(blob, 0, 4);
  return u32(dv, 0) === 0x04034b50 || u32(dv, 0) === 0x06054b50;
}

/** Entries of a zip: [{ name, size, read(): Promise<Uint8Array> }], folders and Finder clutter left out. */
export async function listZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await slice(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  let count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const recOff = u64(tail, loc + 8);
      const rec = await slice(blob, recOff, recOff + 56);
      count = u64(rec, 32); cdSize = u64(rec, 40); cdOffset = u64(rec, 48);
    }
  }
  const cd = await slice(blob, cdOffset, cdOffset + cdSize);
  const utf8 = new TextDecoder(), latin1 = new TextDecoder('latin1');
  const entries = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8), method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    const name = (flags & 0x800 ? utf8 : latin1).decode(nameBytes);
    // ZIP64 extended sizes live in extra field 0x0001, in this order, only when needed.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); q += 8; }
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    const base = name.split('/').pop();
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || base.startsWith('._') || base === '.DS_Store') continue;
    if (flags & 1) continue; // encrypted
    entries.push({
      name, size,
      async read() {
        const head = await slice(blob, offset, offset + 30);
        if (u32(head, 0) !== 0x04034b50) throw new Error(`bad zip entry ${name}`);
        const start = offset + 30 + u16(head, 26) + u16(head, 28);
        const data = blob.slice(start, start + compSize);
        if (method === 0) return new Uint8Array(await data.arrayBuffer());
        if (method !== 8) throw new Error(`${name}: unsupported compression (${method})`);
        const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return entries;
}
