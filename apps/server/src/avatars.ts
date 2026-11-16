import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getOrCreateSetting, type DB } from './db.ts';

export const AVATAR_MAX_BYTES = 200 * 1024;
export type AvatarMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Public path of a user's avatar, or null if they have none. The version busts caches on change. */
export function avatarUrl(userId: string, version: number | null | undefined): string | null {
  return version ? `/api/avatars/${userId}?v=${version}` : null;
}

const signingKey = (db: DB) => getOrCreateSetting(db, 'avatar_url_secret', () => randomBytes(32).toString('base64url'));
const sign = (db: DB, userId: string, version: number) =>
  createHmac('sha256', signingKey(db)).update(`avatar:${userId}:${version}`).digest('base64url').slice(0, 32);

/**
 * An absolute avatar URL that works without a login, for Neko's member list on the Tank origin
 * (which can't rely on FishTank's session cookie). Only this exact user+version is unlocked.
 */
export function signedAvatarUrl(db: DB, baseUrl: string, userId: string, version: number | null | undefined): string | null {
  return version ? `${baseUrl}/api/avatars/${userId}?v=${version}&sig=${sign(db, userId, version)}` : null;
}

export function checkAvatarSignature(db: DB, userId: string, version: string | undefined, sig: string | undefined): boolean {
  const v = Number(version);
  if (!sig || !Number.isSafeInteger(v) || v <= 0) return false;
  const current = (db.prepare('SELECT avatar_version AS v FROM users WHERE id = ?').get(userId) as { v: number | null } | undefined)?.v;
  if (current !== v) return false; // old links stop working when the avatar changes
  const want = Buffer.from(sign(db, userId, v));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Identifies the image type from its first bytes. Only raster formats are accepted
 * (no SVG: it can carry script), and the declared type is never trusted.
 */
export function sniffImage(buf: Buffer): AvatarMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function saveAvatar(db: DB, userId: string, data: Buffer, mime: AvatarMime): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(userId, mime, data, now);
  db.prepare('UPDATE users SET avatar_version = ? WHERE id = ?').run(now, userId);
  return now;
}

export function deleteAvatar(db: DB, userId: string): void {
  db.prepare('DELETE FROM avatars WHERE user_id = ?').run(userId);
  db.prepare('UPDATE users SET avatar_version = NULL WHERE id = ?').run(userId);
}

export function getAvatar(db: DB, userId: string): { mime: AvatarMime; data: Uint8Array } | null {
  return (db.prepare('SELECT mime, data FROM avatars WHERE user_id = ?').get(userId) as { mime: AvatarMime; data: Uint8Array } | undefined) ?? null;
}
