import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import type { RouteCtx } from '../app.ts';
import { SESSION_COOKIE, createSession } from '../sessions.ts';
import { TankError } from '../tanks.ts';

const CODE = '^[A-Za-z0-9-]{4,64}$';
const codeParams = { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: CODE } } } as const;
type CodeParams = { Params: { code: string } };
// Crawlers and everyone behind Docker Desktop share one IP, so this is effectively a global cap.
const LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Link previews (Discord, Slack, iMessage…) for /join/<TANK code> invite links: the page gets
 * Open Graph tags with the Tank's name, host and a screenshot. No login needed, since the
 * crawler has none; anyone holding the code can already join. Unknown codes get generic tags.
 */
export async function shareRoutes(app: FastifyInstance, { config, db, tanks, indexHtml }: RouteCtx & { indexHtml: string | null }) {
  let template: string | null = null;

  if (indexHtml) app.get<CodeParams>('/join/:code', { config: LIMIT, schema: { params: codeParams } }, async (req, reply) => {
    template ??= await readFile(indexHtml, 'utf8');
    const info = await tanks.shareInfo(req.params.code).catch(() => null);
    const url = `${config.publicUrl}/join/${encodeURIComponent(req.params.code)}`;
    const tags: Array<[string, string]> = info
      ? [
          ['og:title', `Join “${info.name}” on FishTank`],
          [
            'og:description',
            info.status === 'open'
              ? `${info.host} is hosting a watch party${info.viewerCount ? ` · ${info.viewerCount} watching` : ''}.`
              : `${info.host} is starting a watch party.`,
          ],
        ]
      : [
          ['og:title', 'FishTank'],
          ['og:description', 'Private watch parties for your school of friends.'],
        ];
    tags.push(['og:site_name', 'FishTank'], ['og:type', 'website'], ['og:url', url], ['theme-color', '#2bb3c0']);
    if (info?.previewAt) {
      tags.push(
        ['og:image', `${config.publicUrl}/api/tank-codes/${encodeURIComponent(req.params.code)}/preview.jpg?v=${info.previewAt}`],
        ['og:image:width', '1280'],
        ['og:image:height', '720'],
        ['twitter:card', 'summary_large_image'],
      );
    }
    const meta = tags
      .map(([k, v]) => `<meta ${k.startsWith('og:') ? 'property' : 'name'}="${k}" content="${esc(v)}" />`)
      .join('\n    ');
    const html = template.replace('</head>', `    ${meta}\n  </head>`);
    return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  // What the join page shows before choosing "watch as a guest" or "log in".
  app.get<CodeParams>('/api/tank-codes/:code', { config: LIMIT, schema: { params: codeParams } }, async (req) => {
    const info = tanks.codeInfo(req.params.code);
    if (!info) throw new TankError('That Tank invite code is invalid, used up, or expired', 404);
    return info;
  });

  /**
   * Watch as a guest: no account, a random name, this one Tank only, and no control of the
   * browser. The guest is deleted when they disconnect, leave, are removed, or the Tank closes.
   */
  app.post<CodeParams>(
    '/api/tank-codes/:code/guest',
    {
      // Per IP (Caddy forwards real client IPs), so one outsider spamming bad codes can't
      // stop everyone else's guests from joining. A code is needed anyway (60 bits).
      config: { rateLimit: { max: 30, timeWindow: '15 minutes', keyGenerator: (req) => `guest-join:${req.ip}` } },
      schema: { params: codeParams },
    },
    async (req, reply) => {
      if (req.user) throw new TankError("You're already signed in", 409);
      const g = tanks.joinAsGuest(req.params.code);
      const days = Math.max(1 / 24, (g.expiresAt - Date.now()) / 86_400_000);
      const token = createSession(db, g.userId, days, req.ip, req.headers['user-agent']);
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'lax',
        maxAge: Math.round(days * 86_400),
      });
      return reply.code(201).send({ tankId: g.tankId });
    },
  );

  app.get<CodeParams>('/api/tank-codes/:code/preview.jpg', { config: LIMIT, schema: { params: codeParams } }, async (req, reply) => {
    const jpeg = tanks.previewForCode(req.params.code);
    if (!jpeg) return reply.code(404).send({ error: 'No preview' });
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=600').send(jpeg);
  });
}
