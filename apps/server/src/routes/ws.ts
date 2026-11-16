import type { FastifyInstance } from 'fastify';
import type { RouteCtx } from '../app.ts';
import type { Connection } from '../realtime.ts';
import { sha256 } from '../security.ts';
import { SESSION_COOKIE } from '../sessions.ts';

/**
 * One WebSocket per open tab. Server → client: friend events, presence, Tank events.
 * Client → server: which Tank this tab is viewing ({type:'tank.join', tankId} / {type:'tank.leave'}),
 * which drives idle detection and "watching" badges.
 * Authenticated by the session cookie. The Origin check stops other sites from opening a
 * socket with the user's cookie (cross-site WebSocket hijacking).
 */
export async function wsRoutes(app: FastifyInstance, { config, hub, tanks }: RouteCtx) {
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const origin = req.headers.origin?.replace(/\/$/, '');
        if (!origin || !config.appOrigins.includes(origin)) return reply.code(403).send({ error: 'Cross-origin request rejected' });
        if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
      },
    },
    (socket, req) => {
      const user = req.user!;
      const token = req.cookies[SESSION_COOKIE]!;
      const conn: Connection = { socket, userId: user.id, sessionId: sha256(token), token, alive: true };

      const leaveTank = () => {
        if (conn.tankId) tanks.leave(conn.tankId, conn.userId);
        conn.tankId = undefined;
      };

      socket.on('pong', () => {
        conn.alive = true;
      });
      socket.on('message', (raw) => {
        let msg: { type?: unknown; tankId?: unknown };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'tank.join' && typeof msg.tankId === 'string') {
          if (conn.tankId === msg.tankId) return;
          leaveTank();
          if (tanks.join(msg.tankId, conn.userId)) conn.tankId = msg.tankId;
        } else if (msg.type === 'tank.leave') {
          leaveTank();
        }
      });
      socket.on('close', () => {
        if (hub.isClosed) return; // shutting down: the DB may already be closing
        leaveTank();
        hub.remove(conn);
      });

      hub.add(conn);
      socket.send(JSON.stringify({ type: 'hello', user: { id: user.id, username: user.username, displayName: user.displayName } }));
    },
  );
}
