import { useEffect, useRef, useState } from 'react';
import type { UserSummary } from './api.ts';

export type RealtimeEvent =
  | { type: 'connected' } // client-side: socket (re)opened — resend any subscriptions
  | { type: 'hello'; user: UserSummary }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'friends.changed'; reason?: 'request' | 'accepted'; by?: UserSummary }
  | { type: 'friends.tanks' }
  | { type: 'friends.activity'; userId: string }
  | { type: 'tank.invite'; invite: { id: string; tank: { id: string; name: string }; by: UserSummary | null } }
  | { type: 'tank.updated'; tankId: string }
  | { type: 'tank.closed'; tankId: string; name: string; reason: string }
  | { type: 'tank.removed'; tankId: string; name: string };

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

const SESSION_ENDED = 4001;
const listeners = new Set<(e: RealtimeEvent) => void>();
let socket: WebSocket | null = null;

function emit(e: RealtimeEvent) {
  for (const l of [...listeners]) l(e);
}

/** Sends a message if connected (dropped otherwise; pages resend on 'connected'). */
export function sendRealtime(msg: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/** Subscribe to realtime events for the lifetime of a component. */
export function useRealtimeEvent(handler: (e: RealtimeEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const l = (e: RealtimeEvent) => ref.current(e);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

/**
 * Owns the single WebSocket to /api/ws (mount once, in the logged-in shell). Reconnects with
 * backoff. `onSessionEnded` fires when the server closes because the session is gone, with the
 * server's reason (e.g. "guest:Tank drained" when a guest pass ends).
 */
export function useRealtimeConnection(onSessionEnded: (reason: string) => void): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  const ended = useRef(onSessionEnded);
  ended.current = onSessionEnded;

  useEffect(() => {
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      socket = ws;
      ws.onopen = () => {
        retry = 0;
        setState('open');
        emit({ type: 'connected' });
      };
      ws.onmessage = (msg) => {
        try {
          emit(JSON.parse(msg.data));
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = (ev) => {
        if (socket === ws) socket = null;
        if (stopped) return;
        if (ev.code === SESSION_ENDED) return ended.current(ev.reason);
        setState('reconnecting');
        const delay = Math.min(30_000, 1000 * 2 ** retry++) * (0.75 + Math.random() * 0.5);
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      socket = null;
    };
  }, []);

  return state;
}
