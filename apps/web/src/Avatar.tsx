import { useState } from 'react';

const COLORS = ['#ff8a3d', '#4fd1a5', '#7aa2ff', '#f06595', '#ffd43b', '#9775fa', '#38d9a9', '#ff6b6b'];

function colorFor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

/** Round avatar: the user's picture, or their initial on a stable color. */
export function Avatar({ name, url, size = 28, seed }: { name: string; url?: string | null; size?: number; seed?: string }) {
  const [broken, setBroken] = useState(false);
  const dim = { width: size, height: size };
  if (url && !broken) {
    return <img className="avatar" src={url} alt="" width={size} height={size} style={dim} onError={() => setBroken(true)} loading="lazy" />;
  }
  return (
    <span className="avatar avatar-initial" aria-hidden style={{ ...dim, background: colorFor(seed ?? name), fontSize: Math.round(size * 0.45) }}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/**
 * Center-crops and resizes an image file to a square in the browser, returning base64
 * (WebP where supported, JPEG otherwise). Keeps uploads small and strips metadata.
 */
export async function prepareAvatar(file: File, size = 256): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image this browser can read");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();

  const toBlob = (type: string, q: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
  let blob = await toBlob('image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.88);
  if (!blob) throw new Error('Could not process the image');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
