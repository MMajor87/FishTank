import type { FastifyInstance } from 'fastify';
import { requireUser, type RouteCtx } from '../app.ts';
import { AVATAR_MAX_BYTES, avatarUrl, checkAvatarSignature, deleteAvatar, getAvatar, saveAvatar, sniffImage } from '../avatars.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export async function avatarRoutes(app: FastifyInstance, { db, tanks }: RouteCtx) {
  // Logged in for everything, except avatar images fetched with a valid signed link (Neko's member list).
  app.addHook('preHandler', async (req, reply) => {
    const q = req.query as { v?: string; sig?: string };
    const p = req.params as { userId?: string };
    if (req.method === 'GET' && p.userId && checkAvatarSignature(db, p.userId, q.v, q.sig)) return;
    return requireUser(req, reply);
  });

  // Upload: base64 image (the browser crops/resizes to 256×256 first).
  app.put<{ Body: { image: string } }>(
    '/account/avatar',
    {
      bodyLimit: Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        body: {
          type: 'object',
          required: ['image'],
          additionalProperties: false,
          properties: { image: { type: 'string', minLength: 16, maxLength: Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 4 } },
        },
      },
    },
    async (req, reply) => {
      const data = Buffer.from(req.body.image.replace(/^data:[^,]*,/, ''), 'base64');
      if (data.length > AVATAR_MAX_BYTES) return reply.code(413).send({ error: 'Image is too large (200 KB max)' });
      const mime = sniffImage(data);
      if (!mime) return reply.code(415).send({ error: 'Use a PNG, JPEG or WebP image' });
      const version = saveAvatar(db, req.user!.id, data, mime);
      void tanks.refreshNekoProfile(req.user!.id);
      return { avatarUrl: avatarUrl(req.user!.id, version) };
    },
  );

  app.delete('/account/avatar', async (req) => {
    deleteAvatar(db, req.user!.id);
    void tanks.refreshNekoProfile(req.user!.id);
    return { ok: true };
  });

  // Visible to logged-in users, or with a signed link (see signedAvatarUrl). URLs are versioned,
  // so they can be cached for good.
  app.get<{ Params: { userId: string } }>(
    '/avatars/:userId',
    { schema: { params: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const avatar = getAvatar(db, req.params.userId);
      if (!avatar) return reply.code(404).send({ error: 'No avatar' });
      return reply
        .header('content-type', avatar.mime)
        .header('cache-control', 'private, max-age=31536000, immutable')
        .header('content-disposition', 'inline; filename="avatar"')
        .send(Buffer.from(avatar.data));
    },
  );
}
