import type { FastifyInstance } from 'fastify';
import { requireUser, type RouteCtx } from '../app.ts';
import { tankPathPrefix } from '../orchestrator.ts';
import { TankError } from '../tanks.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const;
type IdParams = { Params: { id: string } };

export async function tankRoutes(app: FastifyInstance, { config, tanks, recordings }: RouteCtx) {
  app.addHook('preHandler', requireUser);

  /** Member-only access to a Tank; 404 for non-members so Tank ids can't be probed. */
  const memberOf = (tankId: string, userId: string) => {
    const tank = tanks.get(tankId);
    const role = tank ? tanks.role(tankId, userId) : null;
    if (!tank || !role) throw new TankError('Tank not found', 404);
    return { tank, role };
  };

  app.get('/tanks', async (req) => ({ tanks: tanks.listFor(req.user!.id) }));

  app.get<IdParams>('/tanks/:id/preview', { schema: { params: idParams } }, async (req, reply) => {
    const jpeg = tanks.previewFor(req.params.id, req.user!.id);
    if (!jpeg) throw new TankError('No preview', 404);
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=600').send(jpeg);
  });

  app.get('/tanks/friends', async (req) => ({ tanks: tanks.friendsTanksFor(req.user!.id) }));

  app.post<IdParams>(
    '/tanks/:id/join',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } }, schema: { params: idParams } },
    async (req) => ({ tankId: tanks.joinAsFriend(req.params.id, req.user!.id) }),
  );

  app.patch<IdParams & { Body: { friendsCanJoin: boolean } }>(
    '/tanks/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['friendsCanJoin'], additionalProperties: false, properties: { friendsCanJoin: { type: 'boolean' } } },
      },
    },
    async (req) => {
      memberOf(req.params.id, req.user!.id);
      tanks.setFriendsCanJoin(req.params.id, req.user!.id, req.body.friendsCanJoin);
      return { ok: true };
    },
  );

  app.post<{ Body: { name: string } }>(
    '/tanks',
    {
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
    async (req, reply) => {
      const name = req.body.name.trim();
      if (!name) throw new TankError('Give your Tank a name', 400);
      const tank = tanks.create(req.user!.id, name);
      return reply.code(201).send({ tank: { id: tank.id, name: tank.name, status: tank.status } });
    },
  );

  app.get<IdParams>('/tanks/:id', { schema: { params: idParams } }, async (req) => {
    const me = req.user!;
    const { tank, role } = memberOf(req.params.id, me.id);
    if (tank.status === 'closed') return { tank: { id: tank.id, name: tank.name, status: 'closed', closeReason: tank.close_reason } };

    // Only a one-time ticket: the Tank origin exchanges it for cookies and signs the person in
    // to Neko from the server, so no password is ever in this URL.
    let embedUrl: string | null = null;
    if (tank.status === 'open' && tanks.credentialsFor(tank.id)) {
      embedUrl = `${config.tanks.origin}${tankPathPrefix(tank.id)}/?${new URLSearchParams({ ticket: tanks.issueTicket(tank.id, me.id) })}`;
    }
    return {
      tank: {
        id: tank.id,
        name: tank.name,
        status: tank.status,
        hostId: tank.host_id,
        createdAt: tank.created_at,
        expiresAt: tank.expires_at,
        idleMinutes: config.tanks.idleMinutes,
        friendsCanJoin: !!tank.friends_can_join,
      },
      role,
      members: tanks.members(tank.id),
      pendingInvitees: role === 'host' ? tanks.pendingInviteeIds(tank.id) : [],
      // null when recording is off. Everyone in the Tank sees when it's being recorded.
      recording: recordings.tankInfo(tank.id, me),
      embedUrl,
    };
  });

  app.delete<IdParams>('/tanks/:id', { schema: { params: idParams } }, async (req) => {
    const me = req.user!;
    const tank = tanks.get(req.params.id);
    const isHost = tank?.host_id === me.id;
    if (!tank || (!isHost && me.role !== 'admin' && !tanks.role(tank.id, me.id))) throw new TankError('Tank not found', 404);
    if (!isHost && me.role !== 'admin') throw new TankError('Only the host can drain the Tank', 403);
    await tanks.close(tank.id, isHost ? 'drained by host' : 'closed by an admin');
    return { ok: true };
  });

  app.post<IdParams & { Body: { userIds: string[] } }>(
    '/tanks/:id/invites',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['userIds'],
          additionalProperties: false,
          properties: { userIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', pattern: UUID } } },
        },
      },
    },
    async (req) => {
      memberOf(req.params.id, req.user!.id);
      return { invited: tanks.inviteFriends(req.params.id, req.user!.id, req.body.userIds) };
    },
  );

  app.post<IdParams & { Body: { maxUses?: number; expiresInHours?: number } }>(
    '/tanks/:id/codes',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            maxUses: { type: 'integer', minimum: 1, maximum: 20 },
            expiresInHours: { type: 'integer', minimum: 1, maximum: 24 },
          },
        },
      },
    },
    async (req, reply) => {
      memberOf(req.params.id, req.user!.id);
      const created = tanks.createCode(req.params.id, req.user!.id, {
        maxUses: req.body?.maxUses ?? 1,
        expiresInHours: req.body?.expiresInHours,
      });
      return reply.code(201).send({ ...created, link: `${config.publicUrl}/join/${created.code}` });
    },
  );

  app.get<IdParams>('/tanks/:id/codes', { schema: { params: idParams } }, async (req) => {
    memberOf(req.params.id, req.user!.id);
    return { codes: tanks.listCodes(req.params.id, req.user!.id) };
  });

  app.delete<{ Params: { id: string; codeId: string } }>(
    '/tanks/:id/codes/:codeId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'codeId'],
          properties: { id: { type: 'string', pattern: UUID }, codeId: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (req) => {
      memberOf(req.params.id, req.user!.id);
      tanks.revokeCode(req.params.id, req.user!.id, req.params.codeId);
      return { ok: true };
    },
  );

  app.post<IdParams>('/tanks/:id/leave', { schema: { params: idParams } }, async (req) => {
    memberOf(req.params.id, req.user!.id);
    await tanks.leaveTank(req.params.id, req.user!.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/tanks/:id/members/:userId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'userId'],
          properties: { id: { type: 'string', pattern: UUID }, userId: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (req) => {
      memberOf(req.params.id, req.user!.id);
      await tanks.removeMember(req.params.id, req.user!.id, req.params.userId);
      return { ok: true };
    },
  );

  app.get('/tank-invites', async (req) => ({ invites: tanks.invitesFor(req.user!.id) }));

  app.post<IdParams>('/tank-invites/:id/accept', { schema: { params: idParams } }, async (req) => ({
    tankId: tanks.respondToInvite(req.params.id, req.user!.id, true),
  }));

  app.post<IdParams>('/tank-invites/:id/decline', { schema: { params: idParams } }, async (req) => {
    tanks.respondToInvite(req.params.id, req.user!.id, false);
    return { ok: true };
  });

  app.post<{ Body: { code: string } }>(
    '/tank-codes/redeem',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 4, maxLength: 64 } } },
      },
    },
    async (req) => ({ tankId: tanks.redeemCode(req.body.code, req.user!.id) }),
  );
}
