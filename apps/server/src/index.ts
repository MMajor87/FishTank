import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './app.ts';
import { ensureBootstrapCode } from './codes.ts';
import { purgeExpiredSessions } from './sessions.ts';
import { scheduleBackups } from './backups.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = await buildApp({ config, db });

const bootstrap = ensureBootstrapCode(db);
if (bootstrap) {
  app.log.warn('No accounts exist yet. Register the first (admin) account with this one-time code (valid 24h):');
  app.log.warn(`    ${bootstrap}`);
}

purgeExpiredSessions(db);
const purgeTimer = setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000);

const shutdown = async () => {
  clearInterval(purgeTimer);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
await app.tanks.startBackground();
if (config.backupDir) scheduleBackups(db, config.backupDir, config.backupKeep, app.log);
