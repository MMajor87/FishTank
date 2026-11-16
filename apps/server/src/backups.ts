import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from './db.ts';

const NAME = /^fishtank-\d{8}-\d{6}\.sqlite$/;
const DAY = 24 * 60 * 60 * 1000;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function listBackups(dir: string): Array<{ path: string; mtime: number }> {
  try {
    return readdirSync(dir)
      .filter((f) => NAME.test(f))
      .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** Writes a consistent copy of the live database (VACUUM INTO) and keeps the newest `keep`. */
export function backupDatabase(db: DB, dir: string, keep: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `fishtank-${stamp()}.sqlite`);
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  for (const old of listBackups(dir).slice(keep)) unlinkSync(old.path);
  return path;
}

/** Backs up now if the newest backup is a day old (or missing), then checks hourly. */
export function scheduleBackups(db: DB, dir: string, keep: number, log: FastifyBaseLogger): NodeJS.Timeout {
  const tick = () => {
    const newest = listBackups(dir)[0];
    if (newest && Date.now() - newest.mtime < DAY) return;
    try {
      log.info({ path: backupDatabase(db, dir, keep) }, 'database backup written');
    } catch (err) {
      log.error({ err }, 'database backup failed');
    }
  };
  tick();
  const t = setInterval(tick, 60 * 60 * 1000);
  t.unref();
  return t;
}
