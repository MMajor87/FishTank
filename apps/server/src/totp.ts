import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { normalizeCode, randomCode, sha256 } from './security.ts';

/* RFC 4226 / RFC 6238 time-based one-time passwords (what authenticator apps use). */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUrl(secret: string, account: string, issuer = 'FishTank'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

/**
 * Checks a 6-digit code against the current step ±1 (clock drift). Steps at or before
 * `lastStep` are refused, so a code can't be replayed. Returns the matched step or null.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const step = Math.floor(now / 1000 / STEP_SECONDS);
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code))) return s;
  }
  return null;
}

/* ---- per-user second factor ---- */

export interface TotpState {
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled_at: number | null;
  totp_last_step: number | null;
}

export function getTotpState(db: DB, userId: string): TotpState | null {
  return (
    (db
      .prepare('SELECT totp_secret, totp_pending_secret, totp_enabled_at, totp_last_step FROM users WHERE id = ?')
      .get(userId) as TotpState | undefined) ?? null
  );
}

/** Creates 8 single-use recovery codes (replacing any old ones). Returns them in plaintext, once. */
export function createRecoveryCodes(db: DB, userId: string): string[] {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = randomCode('R', 2, 5).slice(2); // e.g. "7KQ2M-9XD3T"
    codes.push(code);
    db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)').run(userId, sha256(normalizeCode(code)));
  }
  return codes;
}

export function recoveryCodesLeft(db: DB, userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n;
}

/**
 * Verifies a second factor for a user with 2FA enabled: a TOTP code (recorded so it can't be
 * reused) or an unused recovery code (consumed).
 */
export function checkSecondFactor(db: DB, userId: string, code: string): boolean {
  const state = getTotpState(db, userId);
  if (!state?.totp_enabled_at || !state.totp_secret) return false;
  const trimmed = code.replace(/\s/g, '');

  const step = verifyTotp(state.totp_secret, trimmed, state.totp_last_step);
  if (step !== null) {
    const res = db
      .prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)')
      .run(step, userId, step);
    return res.changes === 1;
  }

  const res = db
    .prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .run(Date.now(), userId, sha256(normalizeCode(trimmed)));
  return res.changes === 1;
}
