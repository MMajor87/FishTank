import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteCtx } from '../app.ts';
import { transaction } from '../db.ts';
import { claimCode, findUsableCode } from '../codes.ts';
import { burnPasswordCheck, hashPassword, sha256, verifyPassword } from '../security.ts';
import { SESSION_COOKIE, createSession, deleteSession } from '../sessions.ts';
import { checkSecondFactor } from '../totp.ts';
import { withAvatar } from '../friends.ts';
import { logInvite } from '../invitelog.ts';

// Login attempts are limited per username (so guessing at one account can't lock out others),
// plus a global cap on failed logins. Registration is limited per client IP (Caddy forwards real
// IPs; if they were ever hidden, this degrades to one shared limit). Codes are 60-bit anyway.
const LOGIN_RATE_LIMIT = {
  max: 10,
  timeWindow: '15 minutes',
  keyGenerator: (req: FastifyRequest) => `login:${String((req.body as { username?: unknown })?.username ?? '').toLowerCase()}`,
};
const REGISTER_RATE_LIMIT = { max: 20, timeWindow: '15 minutes', keyGenerator: (req: FastifyRequest) => `register:${req.ip}` };
const FAILED_LOGIN_CAP = 300; // high on purpose: a low global cap would itself let one person lock everyone out
const FAILED_LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILED = 'Invalid username or password';

interface RegisterBody {
  username: string;
  displayName: string;
  password: string;
  code: string;
}
interface LoginBody {
  username: string;
  password: string;
  /** Authenticator code or recovery code, for accounts with 2FA. */
  code?: string;
}

class RegisterConflict extends Error {}

export async function authRoutes(app: FastifyInstance, { config, db, hub }: RouteCtx) {
  // Sliding window of recent failed logins (any username), to stop large-scale guessing.
  let failures: number[] = [];
  const recordFailure = () => failures.push(Date.now());
  const tooManyFailures = () => {
    const cutoff = Date.now() - FAILED_LOGIN_WINDOW_MS;
    failures = failures.filter((t) => t > cutoff);
    return failures.length >= FAILED_LOGIN_CAP;
  };
  const startSession = (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const token = createSession(db, userId, config.sessionDays, req.ip, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      maxAge: config.sessionDays * 24 * 60 * 60,
    });
  };

  const publicUser = (id: string) =>
    withAvatar(db.prepare('SELECT id, username, display_name AS displayName, role, avatar_version AS avatarVersion FROM users WHERE id = ?').get(id) as { id: string; avatarVersion: number | null });

  app.post<{ Body: RegisterBody }>(
    '/auth/register',
    {
      config: { rateLimit: REGISTER_RATE_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'displayName', 'password', 'code'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', pattern: '^[A-Za-z0-9_.-]{3,24}$' },
            displayName: { type: 'string', minLength: 1, maxLength: 40 },
            password: { type: 'string', minLength: 10, maxLength: 200 },
            code: { type: 'string', minLength: 4, maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password, code } = req.body;
      const displayName = req.body.displayName.trim();
      if (!displayName) return reply.code(400).send({ error: 'Display name is required' });

      // Permanent accounts need a FISH- code from an admin. (TANK- links make temporary guests instead.)
      const regCode = findUsableCode(db, code);
      if (!regCode) return reply.code(400).send({ error: 'Sign-up code is invalid, used, or expired' });
      if (/^guest-/i.test(username)) return reply.code(400).send({ error: 'Usernames starting with "guest-" are reserved' });

      const passwordHash = await hashPassword(password);
      const userId = randomUUID();

      try {
        transaction(db, () => {
          if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
            throw new RegisterConflict('That username is taken');
          }
          db.prepare(
            'INSERT INTO users (id, username, display_name, password_hash, role, created_at, invited_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(userId, username, displayName, passwordHash, regCode.grants_role, Date.now(), regCode.created_by);
          if (!claimCode(db, regCode.id, userId)) throw new RegisterConflict('Sign-up code is invalid, used, or expired');
          logInvite(db, { kind: 'account', userId, userName: username, invitedBy: regCode.created_by });
        });
      } catch (err) {
        if (err instanceof RegisterConflict) return reply.code(409).send({ error: err.message });
        throw err;
      }

      startSession(req, reply, userId);
      return reply.code(201).send({ user: publicUser(userId) });
    },
  );

  app.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      config: { rateLimit: LOGIN_RATE_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', maxLength: 64 },
            password: { type: 'string', maxLength: 200 },
            code: { type: 'string', maxLength: 32 },
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password, code } = req.body;
      if (tooManyFailures()) return reply.code(429).send({ error: 'Too many failed logins right now. Try again in a few minutes.' });
      const row = db
        .prepare('SELECT id, password_hash, disabled, totp_enabled_at FROM users WHERE username = ? AND guest_tank_id IS NULL')
        .get(username) as { id: string; password_hash: string; disabled: number; totp_enabled_at: number | null } | undefined;

      if (!row) {
        await burnPasswordCheck(password);
        recordFailure();
        return reply.code(401).send({ error: LOGIN_FAILED });
      }
      const ok = await verifyPassword(row.password_hash, password);
      if (!ok || row.disabled) {
        recordFailure();
        return reply.code(401).send({ error: LOGIN_FAILED });
      }

      if (row.totp_enabled_at) {
        if (!code?.trim()) return reply.code(401).send({ error: 'Enter the code from your authenticator app', totpRequired: true });
        if (!checkSecondFactor(db, row.id, code)) {
          recordFailure();
          return reply.code(401).send({ error: "That code didn't work", totpRequired: true });
        }
      }

      startSession(req, reply, row.id);
      return { user: publicUser(row.id) };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      deleteSession(db, token);
      hub.closeSession(sha256(token), 'Logged out');
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
    return { user: req.user };
  });
}
