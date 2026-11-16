import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed tokens for Tank access on the separate Tank origin.
 * - 'ticket': ~60s, carried once in the iframe URL, exchanged for a cookie.
 * - 'pass':   ~12h, the Tank-scoped cookie (Path=/<tankId>/).
 * Membership is re-checked on every request, so a token never outlives a revoked membership.
 */
export type TokenKind = 'ticket' | 'pass';

export interface TankToken {
  k: TokenKind;
  t: string; // tank id
  u: string; // user id
  e: number; // expiry (ms)
  n?: string; // tickets: random nonce, so each one works only once
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function signToken(secret: string, payload: TankToken): string {
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(secret: string, token: string | undefined, kind: TokenKind, tankId: string): TankToken | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as TankToken;
    if (p.k !== kind || p.t !== tankId || typeof p.u !== 'string' || !(p.e > Date.now())) return null;
    return p;
  } catch {
    return null;
  }
}
