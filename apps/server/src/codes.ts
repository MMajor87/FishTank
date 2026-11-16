import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { normalizeCode, randomCode, sha256 } from './security.ts';

const HOUR = 60 * 60 * 1000;

export interface RegistrationCodeRow {
  id: string;
  grants_role: 'admin' | 'member';
  /** Who made the code (null = first-run bootstrap). */
  created_by: string | null;
}

export function createRegistrationCode(
  db: DB,
  opts: { createdBy: string | null; grantsRole?: 'admin' | 'member'; note?: string | null; expiresInHours: number },
): { id: string; code: string; expiresAt: number } {
  const code = randomCode('FISH');
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = now + opts.expiresInHours * HOUR;
  db.prepare(
    `INSERT INTO registration_codes (id, code_hash, created_by, grants_role, note, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sha256(normalizeCode(code)), opts.createdBy, opts.grantsRole ?? 'member', opts.note ?? null, now, expiresAt);
  return { id, code, expiresAt };
}

/** Finds a code that is unused, unrevoked and unexpired. */
export function findUsableCode(db: DB, code: string): RegistrationCodeRow | null {
  const row = db
    .prepare(
      `SELECT id, grants_role, created_by FROM registration_codes
       WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(sha256(normalizeCode(code)), Date.now()) as RegistrationCodeRow | undefined;
  return row ?? null;
}

/** Marks a code used. Returns false if someone else claimed it first. */
export function claimCode(db: DB, codeId: string, userId: string): boolean {
  const res = db
    .prepare('UPDATE registration_codes SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
    .run(userId, Date.now(), codeId);
  return res.changes === 1;
}

/**
 * First-run bootstrap: if there are no users, issue a one-time admin registration code.
 * Any earlier unused bootstrap codes are revoked so only the latest printed code works.
 */
export function ensureBootstrapCode(db: DB): string | null {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return null;
  db.prepare(
    `UPDATE registration_codes SET revoked_at = ? WHERE created_by IS NULL AND grants_role = 'admin' AND used_at IS NULL AND revoked_at IS NULL`,
  ).run(Date.now());
  return createRegistrationCode(db, { createdBy: null, grantsRole: 'admin', note: 'bootstrap', expiresInHours: 24 }).code;
}
