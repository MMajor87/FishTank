import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { RecordingManager } from './recordings.ts';
import { TankError } from './tanks.ts';
import { sendVideo } from './routes/recordings.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

declare module 'fastify' {
  interface FastifyRequest {
    /** Tank-side playback server only: the open Tank this request comes from. */
    playbackTankId: string;
  }
}

/**
 * The Tank-side playback server (docs/RECORDING.md, Phase 5). A Tank's own Firefox opens it to play
 * any finished recording on the Tank's screen, so everyone in the Tank watches together. One that
 * someone sends to the Tank from the site ("shared") opens there by itself.
 *
 * It listens on its own port on the Tank network, which the egress firewall opens to Tanks (the
 * real app's port stays closed to them). There are no accounts here: the caller is identified by
 * source IP, which must be an open Tank's container. Anything else is a 404, so the address is
 * useless outside a Tank.
 */
export async function buildTankPlayback(recordings: RecordingManager, log?: FastifyBaseLogger): Promise<FastifyInstance> {
  const app = Fastify({
    ...(log ? { loggerInstance: log.child({ server: 'tank-playback' }) } : { logger: false }),
    trustProxy: false, // only the socket's address counts
    bodyLimit: 1024,
  });
  app.decorateRequest('playbackTankId', '');

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof TankError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : (err as Error).message });
  });

  app.addHook('onRequest', async (req, reply) => {
    const tankId = await recordings.tankForAddress(req.socket.remoteAddress ?? '');
    if (!tankId) return reply.code(404).send({ error: 'Not found' });
    req.playbackTankId = tankId;
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE));
  app.get<{ Params: { id: string } }>(
    '/r/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE),
  );
  app.get('/shared.json', async (req) => ({ recordings: recordings.readyList(), shared: recordings.sharedFor(req.playbackTankId) }));
  app.get<{ Params: { id: string }; Querystring: { part?: number } }>(
    '/r/:id/video',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        querystring: { type: 'object', additionalProperties: false, properties: { part: { type: 'integer', minimum: 0, maximum: 99 } } },
      },
    },
    async (req, reply) => sendVideo(req, reply, recordings.partPath(req.params.id, req.query.part ?? 0)),
  );
  app.get('/tank.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(SCRIPT));
  app.get('/tank.css', async (_req, reply) => reply.type('text/css; charset=utf-8').send(STYLE));

  return app;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recordings · FishTank</title>
<link rel="stylesheet" href="/tank.css">
<script src="/tank.js" defer></script>
</head>
<body>
<main id="app"><p class="muted">Loading…</p></main>
</body>
</html>
`;

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e3f2f7;
  background: radial-gradient(ellipse at top, #123444, #071a24 55%, #04121a);
}
a { color: #7fd4f0; }
.muted { color: #8fb3c1; }
.list { max-width: 820px; margin: 0 auto; padding: 40px 24px; }
.list h1 { margin: 0 0 4px; font-size: 2rem; }
.list ul { list-style: none; padding: 0; margin: 24px 0 0; display: grid; gap: 12px; }
.list li a {
  display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: center; padding: 18px 20px;
  background: #0d2836; border: 1px solid #1f4a5e; border-radius: 14px; text-decoration: none; color: inherit;
}
.list li a:hover, .list li a:focus-visible { border-color: #4fd1a5; outline: none; }
.play { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; background: #4fd1a5; color: #071a24; font-size: 1.3rem; }
.title { font-size: 1.2rem; font-weight: 600; }
.meta { font-size: .9rem; }
.empty { margin-top: 32px; padding: 24px; border: 1px dashed #1f4a5e; border-radius: 14px; }
.player { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
.bar { display: flex; gap: 16px; align-items: center; padding: 8px 16px; background: #04121a; min-height: 44px; flex-wrap: wrap; }
.bar .title { font-size: 1rem; }
.bar .spacer { flex: 1; }
video { width: 100%; height: 100%; min-height: 0; background: #000; display: block; }
.parts button {
  font: inherit; color: inherit; background: #0d2836; border: 1px solid #1f4a5e; border-radius: 8px; padding: 4px 10px; cursor: pointer;
}
.parts button[aria-current="true"] { border-color: #4fd1a5; color: #4fd1a5; }
.gone { padding: 40px; text-align: center; }
`;

/** Plain browser script (no build step). Polls the shared list; a newly shared recording opens itself. */
const SCRIPT = `
(() => {
  const app = document.getElementById('app');
  const m = location.pathname.match(/^\\/r\\/([0-9a-f-]{36})$/);
  const currentId = m ? m[1] : null;
  let part = Math.max(0, parseInt(new URLSearchParams(location.search).get('part') || '0', 10) || 0);
  let seenAt = null; // newest sharedAt when this page loaded
  let rendered = false;

  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const clock = (ms) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000)), h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
  };
  const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  function renderList(all) {
    document.title = 'Recordings · FishTank';
    app.replaceChildren(el('div', { class: 'list' },
      el('h1', {}, '📼 Recordings'),
      el('p', { class: 'muted' }, 'Pick one to play it for everyone in this Tank. A recording someone sends here from the FishTank site opens by itself.'),
      all.length
        ? el('ul', {}, ...all.map((r) => el('li', {}, el('a', { href: '/r/' + r.id },
            el('span', { class: 'play', 'aria-hidden': 'true' }, '▶'),
            el('span', {}, el('div', { class: 'title' }, (r.kind === 'clip' ? '✂ Clip · ' : '') + r.tankName), el('div', { class: 'meta muted' }, when(r.startedAt) + (r.kind === 'clip' ? ' · clipped by ' : ' · recorded by ') + r.startedBy)),
            el('span', { class: 'meta' }, clock(r.durationMs))))))
        : el('div', { class: 'empty muted' }, 'No recordings yet.'),
    ));
  }

  function renderPlayer(r) {
    document.title = r.tankName + ' · Recordings';
    if (part >= r.parts.length) part = 0;
    const video = el('video', { src: '/r/' + r.id + '/video?part=' + part, controls: '', autoplay: '', playsinline: '', preload: 'metadata' });
    video.addEventListener('ended', () => { if (part + 1 < r.parts.length) go(r.id, part + 1); });
    const parts = r.parts.length > 1
      ? el('span', { class: 'parts' }, ...r.parts.map((p) => el('button', { 'aria-current': String(p.index === part), onclick: () => go(r.id, p.index) }, 'Part ' + (p.index + 1) + ' · ' + clock(p.durationMs))))
      : null;
    app.replaceChildren(el('div', { class: 'player' },
      el('div', { class: 'bar' },
        el('a', { href: '/' }, '← Recordings'),
        el('span', { class: 'title' }, r.tankName),
        el('span', { class: 'muted' }, when(r.startedAt) + ' · recorded by ' + r.startedBy),
        el('span', { class: 'spacer' }),
        parts),
      video,
      el('div', { class: 'bar muted' }, 'Everyone in the Tank sees this. Whoever has control can pause and seek.'),
    ));
  }

  function go(id, p) { location.href = '/r/' + id + (p ? '?part=' + p : ''); }

  async function refresh() {
    let shared, all;
    try {
      const res = await fetch('/shared.json', { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      shared = body.shared || [];
      all = body.recordings || [];
    } catch { return; }
    const newest = shared.reduce((n, r) => Math.max(n, r.sharedAt), 0);
    if (seenAt === null) seenAt = newest;
    else if (newest > seenAt) {
      const r = shared.find((x) => x.sharedAt === newest);
      seenAt = newest;
      if (r && r.id !== currentId) return go(r.id, 0);
    }
    if (currentId) {
      const r = all.find((x) => x.id === currentId);
      if (!r) {
        const v = app.querySelector('video');
        if (v) v.pause();
        app.replaceChildren(el('div', { class: 'gone' }, el('p', {}, 'This recording was deleted.'), el('a', { href: '/' }, '← Recordings')));
        rendered = false;
        return;
      }
      if (!rendered) { renderPlayer(r); rendered = true; }
    } else {
      renderList(all);
    }
  }

  refresh();
  setInterval(refresh, 3000);
})();
`;
