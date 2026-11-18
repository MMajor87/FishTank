import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser, type RouteCtx } from '../app.ts';
import { TankError } from '../tanks.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } as const;
type IdParams = { Params: { id: string } };

/**
 * Recordings for accounts (docs/RECORDING.md). Only registered when RECORDING_ENABLED=true, so
 * otherwise these are plain 404s. Guests never get here (the app's guest allowlist refuses them).
 */
export async function recordingRoutes(app: FastifyInstance, { recordings }: RouteCtx) {
  app.addHook('preHandler', requireUser);

  /** Admin who is in the Tank starts recording it. Resolves once the recorder has the stream. */
  // Optional timer: stopAt (epoch ms) = stop automatically then; absent/null = no timer.
  const timerBody = {
    type: 'object',
    additionalProperties: false,
    properties: { stopAt: { type: ['integer', 'null'], minimum: 0 } },
  } as const;

  app.post<IdParams & { Body: { stopAt?: number | null } | undefined }>(
    '/tanks/:id/recording',
    // No body schema: an empty body (no timer) is fine, so it's checked here instead.
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { params: idParams } },
    async (req, reply) => {
      const body: unknown = req.body ?? {};
      const keys = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body) : null;
      const stopAt = (body as { stopAt?: unknown }).stopAt ?? null;
      if (!keys || keys.some((k) => k !== 'stopAt') || (stopAt !== null && !Number.isInteger(stopAt))) {
        throw new TankError('Expected { stopAt: <time in ms> | null }', 400);
      }
      const r = await recordings.start(req.params.id, req.user!, { stopAt: stopAt as number | null });
      return reply.code(201).send({ recording: { id: r.id, startedAt: r.started_at, startedBy: r.started_by_name, stopAt: r.stop_at } });
    },
  );

  /** Any account in the Tank (not guests) saves the last minute of its live recording as a clip. */
  app.post<IdParams>(
    '/tanks/:id/clip',
    { config: { rateLimit: { max: 12, timeWindow: '10 minutes' } }, schema: { params: idParams } },
    async (req, reply) => {
      const c = await recordings.clip(req.params.id, req.user!);
      return reply.code(201).send({ clip: { id: c.id, durationMs: c.duration_ms, sizeBytes: c.size_bytes } });
    },
  );

  /** Any admin sets, changes or clears (stopAt: null) a live recording's timer. */
  app.patch<IdParams & { Body: { stopAt: number | null } }>(
    '/tanks/:id/recording',
    { schema: { params: idParams, body: { ...timerBody, required: ['stopAt'] } } },
    async (req) => {
      if (req.user!.role !== 'admin') throw new TankError('Only admins can change the recording timer', 403);
      const r = recordings.setTimer(req.params.id, req.body.stopAt);
      return { recording: { id: r.id, stopAt: r.stop_at } };
    },
  );

  /** Any admin stops a Tank's recording. */
  app.delete<IdParams>('/tanks/:id/recording', { schema: { params: idParams } }, async (req) => {
    if (req.user!.role !== 'admin') throw new TankError('Only admins can stop a recording', 403);
    const active = recordings.activeFor(req.params.id);
    if (!active || !(await recordings.stop(active.id, `stopped by ${req.user!.username}`))) {
      throw new TankError("This Tank isn't being recorded", 404);
    }
    return { ok: true };
  });

  /** Every account can see and play recordings until they're wiped. Admins also get disk use. */
  app.get('/recordings', async (req) => ({
    recordings: recordings.list(),
    storage: req.user!.role === 'admin' ? await recordings.storage() : null,
  }));

  app.get<IdParams & { Querystring: { part?: number } }>(
    '/recordings/:id/video',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', additionalProperties: false, properties: { part: { type: 'integer', minimum: 0, maximum: 99 } } },
      },
    },
    async (req, reply) => sendVideo(req, reply, recordings.partPath(req.params.id, req.query.part ?? 0)),
  );

  /** An account in the Tank shares a recording to play there (on the Tank's Recordings page). */
  const shareBody = {
    type: 'object',
    required: ['recordingId'],
    additionalProperties: false,
    properties: { recordingId: { type: 'string', pattern: UUID } },
  } as const;
  app.post<IdParams & { Body: { recordingId: string } }>(
    '/tanks/:id/playback',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } }, schema: { params: idParams, body: shareBody } },
    async (req) => {
      recordings.share(req.params.id, req.body.recordingId, req.user!);
      return { ok: true };
    },
  );
  app.delete<IdParams & { Params: { recordingId: string } }>(
    '/tanks/:id/playback/:recordingId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'recordingId'],
          properties: { id: { type: 'string', pattern: UUID }, recordingId: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (req) => {
      recordings.unshare(req.params.id, req.params.recordingId, req.user!);
      return { ok: true };
    },
  );

  /** Admin wipes a recording now instead of waiting for it to expire. */
  app.delete<IdParams>('/recordings/:id', { schema: { params: idParams } }, async (req) => {
    if (req.user!.role !== 'admin') throw new TankError('Only admins can delete recordings', 403);
    await recordings.wipe(req.params.id);
    return { ok: true };
  });
}

/**
 * The recorder's hooks: MediaMTX asks whether a stream may publish, and reports when a recording's
 * stream goes up or down. Only the recorder's own address may call these, and Caddy never routes
 * /auth/* from outside.
 */
export async function recorderHookRoutes(app: FastifyInstance, { config, recordings }: RouteCtx) {
  const fromRecorder = (req: FastifyRequest) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '') === config.recording.recorderIp;

  // logLevel 'warn': called for every publish attempt, and the body carries the stream key.
  app.post<{ Body: Record<string, unknown> }>('/auth/recorder', { logLevel: 'warn' }, async (req, reply) => {
    if (!fromRecorder(req)) return reply.code(404).send({ error: 'Not found' });
    const b = req.body ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const ok = recordings.authorizePublish({
      action: str(b.action),
      path: str(b.path),
      query: str(b.query),
      ip: str(b.ip),
      protocol: str(b.protocol),
      user: str(b.user),
      password: str(b.password),
    });
    if (ok) return reply.code(204).send();
    req.log.warn({ action: str(b.action), path: str(b.path), ip: str(b.ip), protocol: str(b.protocol) }, 'recorder refused a stream');
    return reply.code(403).send({ error: 'Refused' });
  });

  app.post<{ Body: { event: 'ready' | 'notready'; path: string } }>(
    '/auth/recorder/event',
    {
      logLevel: 'warn',
      schema: {
        body: {
          type: 'object',
          required: ['event', 'path'],
          properties: { event: { type: 'string', enum: ['ready', 'notready'] }, path: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (req, reply) => {
      if (!fromRecorder(req)) return reply.code(404).send({ error: 'Not found' });
      recordings.recorderEvent(req.body.event, req.body.path);
      return reply.code(204).send();
    },
  );
}

/** Streams one recording file with Range support (null path = 404). Never cached by anything shared. */
export async function sendVideo(req: FastifyRequest, reply: FastifyReply, path: string | null) {
  const size = path ? (await stat(path).catch(() => null))?.size : undefined;
  if (!path || size === undefined) throw new TankError('Recording not found', 404);
  reply.header('content-type', 'video/mp4').header('accept-ranges', 'bytes').header('cache-control', 'private, no-store');
  const range = parseRange(req, size);
  if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
  if (!range) return reply.header('content-length', size).send(createReadStream(path));
  const [start, end] = range;
  return reply
    .code(206)
    .header('content-range', `bytes ${start}-${end}/${size}`)
    .header('content-length', end - start + 1)
    .send(createReadStream(path, { start, end }));
}

/** A single byte range from the Range header: [start, end] inclusive, null = whole file. */
function parseRange(req: FastifyRequest, size: number): [number, number] | null | 'invalid' {
  const h = req.headers.range;
  if (!h) return null;
  // Multiple ranges aren't worth supporting for video; ignoring Range is allowed (RFC 9110).
  if (h.includes(',')) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'invalid';
  return [start, end];
}
