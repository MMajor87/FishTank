import type { FastifyInstance } from 'fastify';
import { requireUser, type RouteCtx } from '../app.ts';
import { transaction } from '../db.ts';
import { deleteFriendship, getFriendship, getUserSummary, isBlocked, listRelations, pair } from '../friends.ts';

const MAX_OUTGOING_PENDING = 50;
// Same message for "no such user" and "that user blocked you", so blocks aren't revealed.
const NO_SUCH_USER = 'No user with that username';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const userIdParams = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string', pattern: UUID } },
} as const;

type UserIdParams = { Params: { userId: string } };

export async function friendRoutes(app: FastifyInstance, { db, hub, tanks }: RouteCtx) {
  app.addHook('preHandler', requireUser);

  const changed = (userId: string, extra: { reason?: 'request' | 'accepted'; byId?: string } = {}) => {
    const by = extra.byId ? getUserSummary(db, extra.byId) ?? undefined : undefined;
    hub.send(userId, { type: 'friends.changed', reason: extra.reason, by });
  };

  app.get('/friends', async (req) => {
    const me = req.user!.id;
    return listRelations(db, me, (id) => hub.isOnline(id), (id) => tanks.watchingFor(me, id));
  });

  // Send a request by username. If they already asked you, this accepts it instead.
  app.post<{ Body: { username: string } }>(
    '/friends/requests',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        body: {
          type: 'object',
          required: ['username'],
          additionalProperties: false,
          properties: { username: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const me = req.user!.id;
      const target = db
        .prepare('SELECT id, disabled FROM users WHERE username = ? AND guest_tank_id IS NULL')
        .get(req.body.username.trim()) as { id: string; disabled: number } | undefined;

      if (!target || target.disabled || isBlocked(db, target.id, me)) return reply.code(404).send({ error: NO_SUCH_USER });
      if (target.id === me) return reply.code(400).send({ error: "You can't friend yourself" });
      if (isBlocked(db, me, target.id)) return reply.code(409).send({ error: 'You blocked this user. Unblock them first.' });

      const existing = getFriendship(db, me, target.id);
      if (existing?.status === 'accepted') return reply.code(409).send({ error: "You're already friends" });
      if (existing && existing.requested_by === me) return reply.code(409).send({ error: 'Request already sent' });

      const [lo, hi] = pair(me, target.id);
      if (existing) {
        // They asked first: mutual request → friends.
        db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_low_id = ? AND user_high_id = ?").run(Date.now(), lo, hi);
        changed(target.id, { reason: 'accepted', byId: me });
        return { status: 'accepted' };
      }

      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'pending' AND requested_by = ?")
        .get(me) as { n: number };
      if (n >= MAX_OUTGOING_PENDING) return reply.code(429).send({ error: 'Too many pending requests' });

      db.prepare(
        "INSERT INTO friendships (user_low_id, user_high_id, status, requested_by, created_at) VALUES (?, ?, 'pending', ?, ?)",
      ).run(lo, hi, me, Date.now());
      changed(target.id, { reason: 'request', byId: me });
      return reply.code(201).send({ status: 'pending' });
    },
  );

  app.post<UserIdParams>('/friends/requests/:userId/accept', { schema: { params: userIdParams } }, async (req, reply) => {
    const me = req.user!.id;
    const other = req.params.userId;
    const row = getFriendship(db, me, other);
    if (row?.status !== 'pending' || row.requested_by !== other) return reply.code(404).send({ error: 'No pending request from that user' });
    const [lo, hi] = pair(me, other);
    db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_low_id = ? AND user_high_id = ?").run(Date.now(), lo, hi);
    changed(other, { reason: 'accepted', byId: me });
    return { ok: true };
  });

  // Decline an incoming request or cancel an outgoing one.
  app.delete<UserIdParams>('/friends/requests/:userId', { schema: { params: userIdParams } }, async (req, reply) => {
    if (!deleteFriendship(db, req.user!.id, req.params.userId, 'pending')) return reply.code(404).send({ error: 'No pending request' });
    changed(req.params.userId);
    return { ok: true };
  });

  app.delete<UserIdParams>('/friends/:userId', { schema: { params: userIdParams } }, async (req, reply) => {
    if (!deleteFriendship(db, req.user!.id, req.params.userId, 'accepted')) return reply.code(404).send({ error: 'Not friends' });
    changed(req.params.userId);
    return { ok: true };
  });

  // Blocking removes any friendship or request and hides you from them.
  app.post<{ Body: { userId: string } }>(
    '/blocks',
    {
      schema: {
        body: { type: 'object', required: ['userId'], additionalProperties: false, properties: { userId: { type: 'string', pattern: UUID } } },
      },
    },
    async (req, reply) => {
      const me = req.user!.id;
      const other = req.body.userId;
      if (other === me) return reply.code(400).send({ error: "You can't block yourself" });
      if (!getUserSummary(db, other)) return reply.code(404).send({ error: 'User not found' });
      const hadRelation = transaction(db, () => {
        db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(me, other, Date.now());
        return deleteFriendship(db, me, other);
      });
      if (hadRelation) changed(other);
      return { ok: true };
    },
  );

  app.delete<UserIdParams>('/blocks/:userId', { schema: { params: userIdParams } }, async (req, reply) => {
    const res = db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user!.id, req.params.userId);
    if (res.changes === 0) return reply.code(404).send({ error: 'Not blocked' });
    return { ok: true };
  });
}
