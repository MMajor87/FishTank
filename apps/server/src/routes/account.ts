import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireUser, type RouteCtx } from '../app.ts';
import { hashPassword, sha256, verifyPassword } from '../security.ts';
import { SESSION_COOKIE } from '../sessions.ts';
import {
  checkSecondFactor,
  createRecoveryCodes,
  generateSecret,
  getTotpState,
  otpauthUrl,
  recoveryCodesLeft,
  verifyTotp,
} from '../totp.ts';

const SENSITIVE_LIMIT = { max: 10, timeWindow: '15 minutes' };
const str = (min: number, max: number) => ({ type: 'string', minLength: min, maxLength: max }) as const;

/** Account security: two-factor auth and password changes. */
export async function accountRoutes(app: FastifyInstance, { db, hub }: RouteCtx) {
  app.addHook('preHandler', requireUser);

  const checkPassword = async (userId: string, password: string, reply: FastifyReply) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
    if (row && (await verifyPassword(row.password_hash, password))) return true;
    reply.code(403).send({ error: 'Password is incorrect' });
    return false;
  };

  app.get('/account/security', async (req) => {
    const s = getTotpState(db, req.user!.id);
    return { totpEnabled: !!s?.totp_enabled_at, recoveryCodesLeft: s?.totp_enabled_at ? recoveryCodesLeft(db, req.user!.id) : 0 };
  });

  // Step 1: confirm password, get a new secret to scan.
  app.post<{ Body: { password: string } }>(
    '/account/2fa/setup',
    {
      config: { rateLimit: SENSITIVE_LIMIT },
      schema: { body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: str(1, 200) } } },
    },
    async (req, reply) => {
      const me = req.user!;
      if (getTotpState(db, me.id)?.totp_enabled_at) return reply.code(409).send({ error: 'Two-factor login is already on' });
      if (!(await checkPassword(me.id, req.body.password, reply))) return reply;
      const secret = generateSecret();
      db.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?').run(secret, me.id);
      return { secret, otpauthUrl: otpauthUrl(secret, me.username) };
    },
  );

  // Step 2: prove the app works by entering a code; returns recovery codes once.
  app.post<{ Body: { code: string } }>(
    '/account/2fa/enable',
    {
      config: { rateLimit: SENSITIVE_LIMIT },
      schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: str(6, 6) } } },
    },
    async (req, reply) => {
      const me = req.user!;
      const s = getTotpState(db, me.id);
      if (s?.totp_enabled_at) return reply.code(409).send({ error: 'Two-factor login is already on' });
      if (!s?.totp_pending_secret) return reply.code(400).send({ error: 'Start setup first' });
      const step = verifyTotp(s.totp_pending_secret, req.body.code, null);
      if (step === null) return reply.code(400).send({ error: "That code didn't match. Check your phone's clock and try again." });
      db.prepare(
        'UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?',
      ).run(Date.now(), step, me.id);
      return { recoveryCodes: createRecoveryCodes(db, me.id) };
    },
  );

  app.post<{ Body: { password: string; code: string } }>(
    '/account/2fa/disable',
    {
      config: { rateLimit: SENSITIVE_LIMIT },
      schema: {
        body: { type: 'object', required: ['password', 'code'], additionalProperties: false, properties: { password: str(1, 200), code: str(1, 32) } },
      },
    },
    async (req, reply) => {
      const me = req.user!;
      if (!getTotpState(db, me.id)?.totp_enabled_at) return reply.code(409).send({ error: 'Two-factor login is already off' });
      if (!(await checkPassword(me.id, req.body.password, reply))) return reply;
      if (!checkSecondFactor(db, me.id, req.body.code)) return reply.code(403).send({ error: "That code didn't work" });
      db.prepare(
        'UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?',
      ).run(me.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(me.id);
      return { ok: true };
    },
  );

  // Changing the password signs out every other session (and closes their live sockets).
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/account/password',
    {
      config: { rateLimit: SENSITIVE_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: { currentPassword: str(1, 200), newPassword: str(10, 200) },
        },
      },
    },
    async (req, reply) => {
      const me = req.user!;
      if (!(await checkPassword(me.id, req.body.currentPassword, reply))) return reply;
      const hash = await hashPassword(req.body.newPassword);
      const current = sha256(req.cookies[SESSION_COOKIE]!);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, me.id);
      const others = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND id != ?').all(me.id, current) as Array<{ id: string }>;
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(me.id, current);
      for (const s of others) hub.closeSession(s.id, 'Password changed');
      return { ok: true, signedOutSessions: others.length };
    },
  );
}
