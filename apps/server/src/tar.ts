/**
 * Minimal ustar reader/writer — just enough for Docker's container archive API
 * (copying a couple of small files in/out of a container).
 */

export interface TarEntry {
  name: string;
  data?: Buffer;
  dir?: boolean;
  mode?: number;
  /** Owner (default root). */
  uid?: number;
  gid?: number;
}

function header(name: string, size: number, dir: boolean, mode: number, uid = 0, gid = 0): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  const h = Buffer.alloc(512);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  h.write(name, 0, 100);
  h.write(octal(mode, 8), 100);
  h.write(octal(uid, 8), 108);
  h.write(octal(gid, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136);
  h.write('        ', 148); // checksum placeholder (spaces)
  h.write(dir ? '5' : '0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

export function tarFiles(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.dir ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0));
    parts.push(header(e.dir && !e.name.endsWith('/') ? `${e.name}/` : e.name, data.length, !!e.dir, e.mode ?? (e.dir ? 0o755 : 0o644), e.uid, e.gid));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(parts);
}

/** Returns the contents of the first regular file in a tar archive. */
export function untarFirstFile(buf: Buffer): Buffer | null {
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return null;
    const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    const dataStart = off + 512;
    if (type === '0' || type === '\0') return buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512; // skip pax headers, dirs, etc.
  }
  return null;
}
