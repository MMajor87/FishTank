import type { DB } from './db.ts';
import { avatarUrl } from './avatars.ts';

export interface FriendshipRow {
  status: 'pending' | 'accepted';
  requested_by: string;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}

type WithVersion = { avatarVersion?: number | null };
/** Replaces the raw avatar_version column with a ready-to-use avatarUrl. */
export function withAvatar<T extends { id: string } & WithVersion>(row: T): Omit<T, 'avatarVersion'> & { avatarUrl: string | null } {
  const { avatarVersion, ...rest } = row;
  return { ...rest, avatarUrl: avatarUrl(row.id, avatarVersion) };
}

/** Friendships are stored once per pair, with the ids ordered. */
export function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function getFriendship(db: DB, a: string, b: string): FriendshipRow | null {
  const [lo, hi] = pair(a, b);
  return (
    (db.prepare('SELECT status, requested_by FROM friendships WHERE user_low_id = ? AND user_high_id = ?').get(lo, hi) as
      | FriendshipRow
      | undefined) ?? null
  );
}

export function deleteFriendship(db: DB, a: string, b: string, status?: FriendshipRow['status']): boolean {
  const [lo, hi] = pair(a, b);
  const res = status
    ? db.prepare('DELETE FROM friendships WHERE user_low_id = ? AND user_high_id = ? AND status = ?').run(lo, hi, status)
    : db.prepare('DELETE FROM friendships WHERE user_low_id = ? AND user_high_id = ?').run(lo, hi);
  return res.changes > 0;
}

export function isBlocked(db: DB, blocker: string, blocked: string): boolean {
  return !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blocker, blocked);
}

/** Ids of accepted friends — the people who may see this user's presence. */
export function friendIds(db: DB, userId: string): string[] {
  const rows = db
    .prepare(
      `SELECT CASE WHEN user_low_id = :me THEN user_high_id ELSE user_low_id END AS id
       FROM friendships WHERE status = 'accepted' AND (user_low_id = :me OR user_high_id = :me)`,
    )
    .all({ me: userId }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getUserSummary(db: DB, id: string): UserSummary | null {
  return (
    ((r) => (r ? withAvatar(r) : null))(
      db.prepare('SELECT id, username, display_name AS displayName, avatar_version AS avatarVersion FROM users WHERE id = ?').get(id) as
        | (UserSummary & WithVersion)
        | undefined,
    )
  );
}

interface RelationRow {
  id: string;
  username: string;
  displayName: string;
  status: 'pending' | 'accepted';
  requestedBy: string;
  createdAt: number;
  acceptedAt: number | null;
  avatarVersion: number | null;
}

/** What a friend is watching: always "in a Tank", plus which one only if you could see it yourself. */
export type InTank = { id: string | null; name: string | null } | null;

/**
 * Everything the Friends panel needs, in one call. `isOnline` comes from the realtime hub,
 * `inTank` from the Tank service's live viewers.
 */
export function listRelations(db: DB, me: string, isOnline: (id: string) => boolean, inTank: (id: string) => InTank = () => null) {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.avatar_version AS avatarVersion, f.status, f.requested_by AS requestedBy,
              f.created_at AS createdAt, f.accepted_at AS acceptedAt
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_low_id = :me THEN f.user_high_id ELSE f.user_low_id END
       WHERE f.user_low_id = :me OR f.user_high_id = :me
       ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all({ me }) as unknown as RelationRow[];

  const user = (r: RelationRow): UserSummary => ({ id: r.id, username: r.username, displayName: r.displayName, avatarUrl: avatarUrl(r.id, r.avatarVersion) });
  const friends = rows
    .filter((r) => r.status === 'accepted')
    .map((r) => ({ ...user(r), online: isOnline(r.id), inTank: inTank(r.id), since: r.acceptedAt }))
    .sort((a, b) => Number(b.online) - Number(a.online));
  const incoming = rows.filter((r) => r.status === 'pending' && r.requestedBy !== me).map((r) => ({ ...user(r), sentAt: r.createdAt }));
  const outgoing = rows.filter((r) => r.status === 'pending' && r.requestedBy === me).map((r) => ({ ...user(r), sentAt: r.createdAt }));
  const blocked = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.avatar_version AS avatarVersion
       FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
    )
    .all(me) as unknown as Array<UserSummary & WithVersion>;

  return { friends, incoming, outgoing, blocked: blocked.map(withAvatar) };
}
