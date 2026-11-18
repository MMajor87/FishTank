import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { friendIds } from './friends.ts';
import { Hub } from './realtime.ts';
import { DockerOrchestrator, type Orchestrator } from './orchestrator.ts';
import { RecordingManager, type RecordingTimings } from './recordings.ts';
import { TankError, TankService } from './tanks.ts';
import { SESSION_COOKIE, getSessionUser, type SessionUser } from './sessions.ts';
import { authRoutes } from './routes/auth.ts';
import { codeRoutes } from './routes/codes.ts';
import { friendRoutes } from './routes/friends.ts';
import { wsRoutes } from './routes/ws.ts';
import { tankRoutes } from './routes/tanks.ts';
import { tankAuthRoutes } from './routes/tankAuth.ts';
import { accountRoutes } from './routes/account.ts';
import { adminRoutes } from './routes/admin.ts';
import { avatarRoutes } from './routes/avatars.ts';
import { shareRoutes } from './routes/share.ts';
import { recorderHookRoutes, recordingRoutes } from './routes/recordings.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    hub: Hub;
    tanks: TankService;
    recordings: RecordingManager;
  }
}

export interface AppDeps {
  config: Config;
  db: DB;
  /** Docker access; defaults to the real Docker orchestrator. Tests pass a fake. */
  orchestrator?: Orchestrator;
}

/** What route plugins receive. */
export interface RouteCtx extends AppDeps {
  hub: Hub;
  tanks: TankService;
  recordings: RecordingManager;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEARTBEAT_MS = 30_000;

export async function buildApp(
  { config, db, orchestrator }: AppDeps,
  opts: { logger?: boolean; heartbeatMs?: number; recordingTimings?: Partial<RecordingTimings>; recorderFetch?: typeof fetch } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    // Request URLs can carry invite and sign-up codes (/join/TANK-…, /?code=FISH-…): keep them out of logs.
    logger:
      (opts.logger ?? true)
        ? {
            serializers: {
              req: (req: { method: string; url: string; host?: string; ip?: string }) => ({
                method: req.method,
                url: redactCodes(req.url),
                host: req.host,
                remoteAddress: req.ip,
              }),
            },
          }
        : false,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  // Presence: tell a user's friends when they come online / go offline.
  const hub: Hub = new Hub((userId, online) => {
    for (const friendId of friendIds(db, userId)) hub.send(friendId, { type: 'presence', userId, online });
  });
  app.decorate('hub', hub);

  const orch = orchestrator ?? new DockerOrchestrator(config.tanks, config.dockerHost, (obj, msg) => app.log.warn(obj, msg));
  const tanks = new TankService({ config, db, hub, orchestrator: orch, log: app.log });
  app.decorate('tanks', tanks);
  const recordings = new RecordingManager({ config, db, hub, orchestrator: orch, tanks, log: app.log, timings: opts.recordingTimings, fetch: opts.recorderFetch });
  if (recordings.enabled) tanks.recordings = recordings;
  app.decorate('recordings', recordings);

  // Expected Tank failures carry their own status; everything else is a 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof TankError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : (err as Error).message });
  });

  await app.register(cookie);
  // Rate limits run after the session is resolved, and count per account when logged in
  // (people sharing a home connection don't throttle each other), per IP otherwise.
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    keyGenerator: (req) => req.user?.id ?? req.ip,
    // Say which limit tripped, for whom, so "too many attempts" reports can be traced.
    onExceeded: (req, key) =>
      req.log.warn({ route: req.routeOptions.url, key: redactCodes(String(key)), ip: req.ip, user: req.user?.username }, 'rate limit hit'),
  });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    // CSRF guard: state-changing API calls must come from our own origin. Combined with
    // SameSite=Lax cookies, cross-site forms and fetches can't act on a user's behalf.
    if (req.url.startsWith('/api/') && UNSAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin?.replace(/\/$/, '');
      if (!origin || !config.appOrigins.includes(origin)) {
        return reply.code(403).send({ error: 'Cross-origin request rejected' });
      }
    }
    // Resolve the session cookie (if any) to a user.
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.user = getSessionUser(db, token, config.sessionDays);
    // Guests may only watch their own Tank: everything else in the API is off limits.
    if (req.user?.guestTankId && req.url.startsWith('/api/') && !guestMayUse(req.method, req.url.split('?')[0]!, req.user.guestTankId)) {
      return reply.code(403).send({ error: 'Guests can only watch the Tank they were invited to' });
    }
  });

  const heartbeat = setInterval(
    () => hub.sweep((c) => getSessionUser(db, c.token, config.sessionDays)?.id === c.userId),
    opts.heartbeatMs ?? HEARTBEAT_MS,
  );
  heartbeat.unref();
  // preClose runs before the server stops accepting/closing connections, so open
  // sockets don't hold shutdown open or fire presence updates against a closing DB.
  app.addHook('preClose', async () => {
    clearInterval(heartbeat);
    tanks.stopBackground();
    recordings.stopBackground();
    hub.closeAll();
  });

  // Security headers for everything the app serves. The page may only frame the Tank origin,
  // talk to itself (fetch + WebSocket), and load its own scripts/styles.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${config.tanks.origin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', csp);
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  });

  app.get('/api/health', async () => ({ ok: true }));

  const ctx: RouteCtx = { config, db, hub, tanks, recordings };
  await app.register(authRoutes, { prefix: '/api', ...ctx });
  await app.register(codeRoutes, { prefix: '/api', ...ctx });
  await app.register(friendRoutes, { prefix: '/api', ...ctx });
  await app.register(wsRoutes, { prefix: '/api', ...ctx });
  await app.register(tankRoutes, { prefix: '/api', ...ctx });
  await app.register(tankAuthRoutes, { ...ctx }); // /auth/tank/:id, called by Caddy only
  await app.register(accountRoutes, { prefix: '/api', ...ctx });
  await app.register(adminRoutes, { prefix: '/api', ...ctx });
  await app.register(avatarRoutes, { prefix: '/api', ...ctx });
  if (recordings.enabled) {
    await app.register(recordingRoutes, { prefix: '/api', ...ctx });
    await app.register(recorderHookRoutes, { ...ctx }); // /auth/recorder*, called by the recorder only
  }

  // Serve the built web app (production). Unknown non-API paths fall back to index.html.
  const webDist = config.webDist ? resolve(config.webDist) : null;
  const hasWeb = !!webDist && existsSync(resolve(webDist, 'index.html'));
  // Invite-link previews (/join/<code>, needs the built page) and guest joining (API, always).
  await app.register(shareRoutes, { ...ctx, indexHtml: hasWeb ? resolve(webDist!, 'index.html') : null });
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });

    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}

/** Blanks out TANK-/FISH- codes (in any case, with or without dashes) in a URL for logging. */
export function redactCodes(url: string): string {
  return url.replace(/\b(TANK|FISH)-?[0-9A-Z]{4}-?[0-9A-Z]{4}-?[0-9A-Z]{4}(?![0-9A-Z])/gi, '$1-…');
}

/** The few API calls a temporary guest may make (default deny). */
export function guestMayUse(method: string, path: string, tankId: string): boolean {
  if (method === 'GET' && (path === '/api/me' || path === '/api/ws' || path === `/api/tanks/${tankId}` || path.startsWith('/api/avatars/'))) return true;
  if (method === 'POST' && (path === '/api/auth/logout' || path === `/api/tanks/${tankId}/leave`)) return true;
  return false;
}

/** preHandler for admin-only routes. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Admins only' });
}

/** preHandler for routes that need a logged-in user. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
}
