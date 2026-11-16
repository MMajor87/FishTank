import type { FastifyInstance } from 'fastify';
import { requireUser, type RouteCtx } from '../app.ts';
import { createRegistrationCode } from '../codes.ts';

const MAX_ACTIVE_CODES_PER_MEMBER = 5;

interface CreateCodeBody {
  note?: string;
  expiresInHours?: number;
}

/**
 * Registration codes: the only way to get a permanent FishTank account. Any member can make
 * them (a few at a time); admins see everyone's. Tank invite links make temporary guests instead.
 */
export async function codeRoutes(app: FastifyInstance, { db }: RouteCtx) {
  app.post<{ Body: CreateCodeBody }>(
    '/registration-codes',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            note: { type: 'string', maxLength: 80 },
            expiresInHours: { type: 'integer', minimum: 1, maximum: 168 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.user!;
      if (user.role !== 'admin') {
        const { n } = db
          .prepare(
            `SELECT COUNT(*) AS n FROM registration_codes
             WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
          )
          .get(user.id, Date.now()) as { n: number };
        if (n >= MAX_ACTIVE_CODES_PER_MEMBER) {
          return reply.code(429).send({ error: `You can have at most ${MAX_ACTIVE_CODES_PER_MEMBER} active codes` });
        }
      }
      const created = createRegistrationCode(db, {
        createdBy: req.user!.id,
        note: req.body?.note?.trim() || null,
        expiresInHours: req.body?.expiresInHours ?? 72,
      });
      // The plaintext code is only ever returned here; the DB stores a hash.
      return reply.code(201).send(created);
    },
  );

  // Your own codes; `?all=1` lists everyone's (admins only, for the Admin page).
  app.get<{ Querystring: { all?: string } }>('/registration-codes', { preHandler: requireUser }, async (req, reply) => {
    const all = req.query.all === '1';
    if (all && req.user!.role !== 'admin') return reply.code(403).send({ error: 'Admins only' });
    const rows = db
      .prepare(
        `SELECT c.id, c.note, c.created_at AS createdAt, c.expires_at AS expiresAt,
                c.used_at AS usedAt, c.revoked_at AS revokedAt, u.username AS usedBy, cb.username AS createdBy
         FROM registration_codes c
         LEFT JOIN users u ON u.id = c.used_by
         LEFT JOIN users cb ON cb.id = c.created_by
         WHERE :all OR c.created_by = :me
         ORDER BY c.created_at DESC LIMIT 100`,
      )
      .all({ all: all ? 1 : 0, me: req.user!.id });
    return { codes: rows };
  });

  // Members revoke their own; admins any.
  app.delete<{ Params: { id: string } }>('/registration-codes/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!;
    const res = db
      .prepare(
        `UPDATE registration_codes SET revoked_at = ?
         WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND (? OR created_by = ?)`,
      )
      .run(Date.now(), req.params.id, user.role === 'admin' ? 1 : 0, user.id);
    if (res.changes !== 1) return reply.code(404).send({ error: 'Code not found or already used' });
    return { ok: true };
  });
}
