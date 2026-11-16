import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';

/** Records a new account or guest for the admin panel, with names copied in (guests get deleted). */
export function logInvite(
  db: DB,
  e: { kind: 'account' | 'guest'; userId: string; userName: string; invitedBy: string | null; tankName?: string | null },
): void {
  const by = e.invitedBy
    ? ((db.prepare('SELECT username FROM users WHERE id = ?').get(e.invitedBy) as { username: string } | undefined)?.username ?? null)
    : null;
  db.prepare(
    `INSERT INTO invite_log (id, kind, user_id, user_name, invited_by, invited_by_name, tank_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), e.kind, e.userId, e.userName, e.invitedBy, by, e.tankName ?? null, Date.now());
}

/** Marks a guest's log entry as ended (call before deleting the guest, while user_id still matches). */
export function endInvite(db: DB, userId: string, reason: string): void {
  db.prepare('UPDATE invite_log SET ended_at = ?, end_reason = ? WHERE user_id = ? AND ended_at IS NULL').run(Date.now(), reason, userId);
}

export function recentInvites(db: DB, limit = 100) {
  return db
    .prepare(
      `SELECT id, kind, user_id AS userId, user_name AS userName, invited_by_name AS invitedByName, tank_name AS tankName,
              created_at AS createdAt, ended_at AS endedAt, end_reason AS endReason
       FROM invite_log ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
}
