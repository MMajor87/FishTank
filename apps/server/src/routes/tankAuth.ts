import type { FastifyInstance } from 'fastify';
import type { RouteCtx } from '../app.ts';
import { NEKO_SESSION_COOKIE, tankPathPrefix } from '../orchestrator.ts';
import { PASS_TTL_MS } from '../tanks.ts';

export const TANK_PASS_COOKIE = 'ftt';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Caddy `forward_auth` target for the Tank origin. Called before every request to
 * https://<tank origin>/<tankId>/... Caddy passes the original URI in X-Forwarded-Uri and
 * the browser's cookies.
 *
 * - First load carries ?ticket=… (60s, single use, from the FishTank app). We verify it, sign the
 *   person in to the Tank's Neko from the server, and answer 302 to the same URL minus the
 *   ticket, setting two Tank-scoped cookies (Path=/<tankId>/): our pass, and Neko's session.
 *   So the Neko password never appears in any URL. Caddy relays non-2xx auth responses as-is.
 * - Later requests carry the pass cookie. 204 = allowed, 401 = not a member / expired.
 *
 * Membership and the Tank being open are re-checked every time.
 */
export async function tankAuthRoutes(app: FastifyInstance, { config, tanks }: RouteCtx) {
  // logLevel 'warn': this runs for every Tank request, and the forwarded URIs can carry
  // Neko session tokens (?token=…), so per-request info logs are off for this route.
  app.get<{ Params: { tankId: string } }>('/auth/tank/:tankId', { logLevel: 'warn' }, async (req, reply) => {
    const { tankId } = req.params;
    if (!UUID.test(tankId)) return reply.code(404).type('text/plain').send('Not found');

    const forwarded = String(req.headers['x-forwarded-uri'] ?? '/');
    const url = new URL(forwarded, 'http://tank.invalid');
    const ticket = url.searchParams.get('ticket');

    if (ticket) {
      url.searchParams.delete('ticket');
      const userId = tanks.checkTicket(tankId, ticket);
      if (!userId) {
        // Already used (e.g. the browser re-requested the first URL): fine if they hold a pass.
        if (tanks.checkPass(tankId, req.cookies[TANK_PASS_COOKIE])) {
          return reply.header('cache-control', 'no-store').redirect(url.pathname + url.search, 302);
        }
        return denied(reply);
      }
      const session = await tanks.nekoSession(tankId, userId).catch((err) => {
        req.log.warn({ err, tankId }, 'neko sign-in failed');
        return null;
      });
      if (!session) {
        return reply.code(503).header('cache-control', 'no-store').type('text/plain').send("This Tank isn't ready. Reload the page in a moment.");
      }
      const cookie = {
        path: `${tankPathPrefix(tankId)}/`,
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'lax' as const,
        maxAge: Math.floor(PASS_TTL_MS / 1000),
      };
      reply.setCookie(TANK_PASS_COOKIE, tanks.issuePass(tankId, userId), cookie);
      if ('cookie' in session) reply.setCookie(NEKO_SESSION_COOKIE, session.cookie, cookie);
      else {
        // Tank started by an older version: its Neko page logs in from the URL (and then removes it).
        url.searchParams.set('usr', session.usr);
        url.searchParams.set('pwd', session.pwd);
      }
      reply.header('cache-control', 'no-store');
      return reply.redirect(url.pathname + url.search, 302);
    }

    if (!tanks.checkPass(tankId, req.cookies[TANK_PASS_COOKIE])) return denied(reply);
    return reply.code(204).send();
  });
}

function denied(reply: import('fastify').FastifyReply) {
  return reply
    .code(401)
    .header('cache-control', 'no-store')
    .type('text/plain')
    .send('Your access to this Tank has expired or was removed. Reopen it from FishTank.');
}
