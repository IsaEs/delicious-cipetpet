// Minimal readers for NumPy's .npz (a zip of .npy files) and .npy formats, enough for the Duyu tables.
import { inflateRawSync } from "node:zlib";

export interface NpyArray {
  /** the file's dtype descriptor, e.g. "<f4" */
  descr: string;
  shape: number[];
  /** the values converted to float32 */
  data: Float32Array;
}

/** Unpack a zip archive into name -> bytes. Handles stored and deflated members and ZIP64 sizes. */
export function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record sits at the end, before a comment of at most 64 KiB.
  let eocd = -1;
  for (let i = zip.byteLength - 22; i >= Math.max(0, zip.byteLength - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  let count = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);
  if (cd === 0xffffffff || count === 0xffff) {
    // ZIP64: the locator just before the EOCD points at the ZIP64 EOCD record
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error("zip: missing ZIP64 locator");
    const rec = Number(dv.getBigUint64(loc + 8, true));
    if (dv.getUint32(rec, true) !== 0x06064b50) throw new Error("zip: bad ZIP64 end record");
    count = Number(dv.getBigUint64(rec + 32, true));
    cd = Number(dv.getBigUint64(rec + 48, true));
  }

  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  let p = cd;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`zip: bad central directory entry at ${p}`);
    const method = dv.getUint16(p + 10, true);
    let compSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extended information (tag 1): only the fields saturated in the record are present, in order
    for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; ) {
      const tag = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (tag === 0x0001) {
        let q = x + 4;
        const next = () => {
          const v = Number(dv.getBigUint64(q, true));
          q += 8;
          return v;
        };
        if (size === 0xffffffff) size = next();
        if (compSize === 0xffffffff) compSize = next();
        if (local === 0xffffffff) local = next();
      }
      x += 4 + len;
    }
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + compSize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`zip: ${name} uses unsupported compression method ${method}`);
    if (data.byteLength !== size) throw new Error(`zip: ${name} is ${data.byteLength} bytes, expected ${size}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Parse a .npy file (format versions 1, 2 and 3) holding a little-endian float array, as float32. */
export function readNpy(npy: Uint8Array, label = "npy"): NpyArray {
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // "\x93NUMPY"
  if (npy.byteLength < 10 || !magic.every((b, i) => npy[i] === b)) throw new Error(`${label}: not a .npy file`);
  const dv = new DataView(npy.buffer, npy.byteOffset, npy.byteLength);
  const major = npy[6];
  let hlen: number, hstart: number;
  if (major === 1) [hlen, hstart] = [dv.getUint16(8, true), 10];
  else if (major === 2 || major === 3) [hlen, hstart] = [dv.getUint32(8, true), 12];
  else throw new Error(`${label}: unsupported .npy version ${major}`);
  // v3 only differs from v2 in allowing UTF-8 in the header
  const header = new TextDecoder(major === 3 ? "utf-8" : "latin1").decode(npy.subarray(hstart, hstart + hlen));

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || !fortran || shapeText === undefined) throw new Error(`${label}: cannot parse header ${header.trim()}`);
  if (fortran === "True") throw new Error(`${label}: Fortran-ordered arrays are not supported`);
  const shape = shapeText.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (!shape.every((d) => Number.isSafeInteger(d) && d >= 0)) throw new Error(`${label}: bad shape (${shapeText})`);
  const n = shape.reduce((a, b) => a * b, 1);

  const body = hstart + hlen;
  const read: Record<string, [number, (o: number) => number]> = {
    "<f4": [4, (o) => dv.getFloat32(o, true)],
    "<f8": [8, (o) => dv.getFloat64(o, true)],
    "<f2": [2, (o) => getFloat16(dv, o)],
  };
  const r = read[descr];
  if (!r) throw new Error(`${label}: unsupported dtype ${descr} (expected little-endian float)`);
  const [size, get] = r;
  if (body + n * size > npy.byteLength) throw new Error(`${label}: truncated data (${n} x ${descr})`);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = get(body + i * size);
  return { descr, shape, data };
}

function getFloat16(dv: DataView, o: number): number {
  const h = dv.getUint16(o, true);
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** All arrays of an .npz, keyed by name without the ".npy" suffix. */
export function readNpz(npz: Uint8Array, label = "npz"): Map<string, NpyArray> {
  const out = new Map<string, NpyArray>();
  for (const [name, bytes] of readZip(npz)) {
    if (!name.endsWith(".npy")) continue;
    const key = name.slice(0, -4);
    out.set(key, readNpy(bytes, `${label}:${name}`));
  }
  return out;
}
