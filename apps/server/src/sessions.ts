import type { DB } from './db.ts';
import { newToken, sha256 } from './security.ts';
import { avatarUrl } from './avatars.ts';

export const SESSION_COOKIE = 'ft_session';
const DAY = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL = 60 * 60 * 1000; // refresh expiry at most hourly

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  avatarUrl: string | null;
  /** Set for temporary guests: the one Tank they may watch. */
  guestTankId: string | null;
}

export function createSession(db: DB, userId: string, days: number, ip?: string, userAgent?: string): string {
  const token = newToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sha256(token), userId, now, now + days * DAY, now, ip ?? null, userAgent?.slice(0, 300) ?? null);
  return token;
}

/** Resolves a cookie token to its user, sliding the expiry forward. Returns null if invalid/expired/disabled. */
export function getSessionUser(db: DB, token: string, days: number): SessionUser | null {
  const id = sha256(token);
  const row = db
    .prepare(
      `SELECT s.expires_at, s.last_seen_at, u.id, u.username, u.display_name, u.role, u.disabled, u.avatar_version, u.guest_tank_id
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as
    | {
        expires_at: number;
        last_seen_at: number;
        id: string;
        username: string;
        display_name: string;
        role: 'admin' | 'member';
        disabled: number;
        avatar_version: number | null;
        guest_tank_id: string | null;
      }
    | undefined;
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now || row.disabled) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  if (now - row.last_seen_at > TOUCH_INTERVAL && !row.guest_tank_id) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, now + days * DAY, id);
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarUrl: avatarUrl(row.id, row.avatar_version),
    guestTankId: row.guest_tank_id,
  };
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}
