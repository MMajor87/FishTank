import type { FastifyInstance } from 'fastify';
import type { RouteCtx } from '../app.ts';
import { TankError } from '../tanks.ts';
import { withAvatar } from '../friends.ts';
import { recentInvites } from '../invitelog.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const;

/** Admin dashboard: live Tanks with resource usage, and account management. Admins only. */
export async function adminRoutes(app: FastifyInstance, { config, db, hub, tanks }: RouteCtx) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Admins only' });
  });

  app.get('/admin/overview', async () => {
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, u.avatar_version AS avatarVersion, u.role, u.disabled, u.created_at AS createdAt,
                u.totp_enabled_at IS NOT NULL AS totp, i.username AS invitedBy,
                u.guest_tank_id AS guestTankId, t.name AS guestTankName,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > :now) AS sessions,
                (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS lastSeenAt
         FROM users u LEFT JOIN users i ON i.id = u.invited_by LEFT JOIN tanks t ON t.id = u.guest_tank_id
         ORDER BY u.created_at`,
      )
      .all({ now: Date.now() }) as Array<Record<string, unknown> & { id: string; avatarVersion: number | null; guestTankId: string | null }>;
    const shape = (u: (typeof users)[number]) => ({ ...withAvatar(u), disabled: !!u.disabled, totp: !!u.totp, online: hub.isOnline(u.id) });
    return {
      tanks: await tanks.adminOverview(),
      users: users.filter((u) => !u.guestTankId).map(shape),
      guests: users.filter((u) => u.guestTankId).map(shape),
      invites: recentInvites(db),
      limits: { maxTanks: config.tanks.maxTanks, cpusPerTank: config.tanks.cpus, memoryGbPerTank: config.tanks.memoryGb },
    };
  });

  /** Disable: sign out everywhere, drain Tanks they host, remove them from others. */
  app.post<{ Params: { id: string } }>('/admin/users/:id/disable', { schema: { params: idParams } }, async (req) => {
    if (req.params.id === req.user!.id) throw new TankError("You can't disable your own account", 400);
    const res = db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(req.params.id);
    if (res.changes !== 1) throw new TankError('User not found', 404);
    const sessions = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(req.params.id) as Array<{ id: string }>;
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
    for (const s of sessions) hub.closeSession(s.id, 'Account disabled');
    await tanks.evictUser(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/enable', { schema: { params: idParams } }, async (req) => {
    const res = db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(req.params.id);
    if (res.changes !== 1) throw new TankError('User not found', 404);
    return { ok: true };
  });
}
