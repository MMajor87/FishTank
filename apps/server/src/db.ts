import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

/**
 * Ordered schema migrations. Never edit an applied migration; append a new one.
 * Applied version is tracked in PRAGMA user_version. Times are epoch milliseconds.
 */
const migrations: string[] = [
  /* 1: accounts */ `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,          -- sha256 of the cookie token
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE registration_codes (
    id          TEXT PRIMARY KEY,
    code_hash   TEXT NOT NULL UNIQUE,       -- sha256 of the normalized code
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system bootstrap
    grants_role TEXT NOT NULL DEFAULT 'member' CHECK (grants_role IN ('admin', 'member')),
    note        TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
    used_at     INTEGER,
    revoked_at  INTEGER
  );
  CREATE INDEX registration_codes_creator ON registration_codes(created_by);
  `,

  /* 2: friends & blocks */ `
  CREATE TABLE friendships (
    user_low_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the pair is stored once,
    user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- ordered low < high
    status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    accepted_at  INTEGER,
    PRIMARY KEY (user_low_id, user_high_id),
    CHECK (user_low_id < user_high_id)
  );
  CREATE INDEX friendships_high ON friendships(user_high_id);

  CREATE TABLE blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
  `,

  /* 3: tanks */ `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE tanks (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    host_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status         TEXT NOT NULL CHECK (status IN ('starting', 'open', 'closed')),
    udp_port       INTEGER NOT NULL,
    container_id   TEXT,
    created_at     INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    closed_at      INTEGER,
    close_reason   TEXT
  );
  -- A UDP port belongs to at most one live Tank.
  CREATE UNIQUE INDEX tanks_live_port ON tanks(udp_port) WHERE status != 'closed';
  CREATE INDEX tanks_status ON tanks(status);

  CREATE TABLE tank_members (
    tank_id   TEXT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL CHECK (role IN ('host', 'guest')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (tank_id, user_id)
  );
  CREATE INDEX tank_members_user ON tank_members(user_id);

  CREATE TABLE tank_invites (
    id              TEXT PRIMARY KEY,
    tank_id         TEXT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
    created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('direct', 'code')),
    invited_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- direct invites
    code_hash       TEXT UNIQUE,                                     -- code invites (sha256)
    max_uses        INTEGER NOT NULL DEFAULT 1,
    uses            INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    revoked_at      INTEGER
  );
  CREATE INDEX tank_invites_tank ON tank_invites(tank_id);
  CREATE UNIQUE INDEX tank_invites_direct ON tank_invites(tank_id, invited_user_id) WHERE kind = 'direct';
  `,

  /* 4: two-factor auth */ `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;           -- base32, set once enrollment is confirmed
  ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;   -- set during enrollment, until confirmed
  ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;     -- last accepted time step (blocks code replay)

  CREATE TABLE recovery_codes (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );
  `,

  /* 5: avatars */ `
  ALTER TABLE users ADD COLUMN avatar_version INTEGER;   -- set when an avatar exists; part of its URL (cache busting)

  CREATE TABLE avatars (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    data       BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  /* 6: friends can see and drop in to the host's live Tanks */ `
  ALTER TABLE tanks ADD COLUMN friends_can_join INTEGER NOT NULL DEFAULT 1;
  `,

  /* 7: last 4 characters of a TANK- code, so the host can tell their links apart (the code itself is only stored hashed) */ `
  ALTER TABLE tank_invites ADD COLUMN code_hint TEXT;
  `,

  /* 8: guest accounts + who invited whom */ `
  -- Set = a temporary guest made from a TANK- invite link: bound to this one Tank, deleted when
  -- they disconnect or it closes. NULL = a permanent account.
  ALTER TABLE users ADD COLUMN guest_tank_id TEXT REFERENCES tanks(id) ON DELETE CASCADE;
  ALTER TABLE users ADD COLUMN invited_by TEXT REFERENCES users(id) ON DELETE SET NULL;
  UPDATE users SET invited_by = (SELECT c.created_by FROM registration_codes c WHERE c.used_by = users.id);

  -- Admin audit trail of new accounts and guests. Names are copied in because guests are deleted.
  CREATE TABLE invite_log (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('account', 'guest')),
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    user_name       TEXT NOT NULL,
    invited_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    invited_by_name TEXT,
    tank_name       TEXT,
    created_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    end_reason      TEXT
  );
  CREATE INDEX invite_log_created ON invite_log(created_at);
  INSERT INTO invite_log (id, kind, user_id, user_name, invited_by, invited_by_name, created_at)
    SELECT lower(hex(randomblob(16))), 'account', u.id, u.username, u.invited_by, i.username, u.created_at
    FROM users u LEFT JOIN users i ON i.id = u.invited_by;
  `,

  /* 9: Tank recordings (docs/RECORDING.md) */ `
  CREATE TABLE recordings (
    id              TEXT PRIMARY KEY,            -- uuid, also the recorder's stream path and folder name
    tank_id         TEXT REFERENCES tanks(id) ON DELETE SET NULL,
    tank_name       TEXT NOT NULL,               -- copied: shown after the Tank is gone
    started_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    started_by_name TEXT NOT NULL,               -- copied, like invite_log
    key_hash        TEXT NOT NULL,               -- sha256 of the current stream key
    status          TEXT NOT NULL CHECK (status IN ('recording', 'processing', 'ready', 'failed')),
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    expires_at      INTEGER,                     -- ended_at + RECORDING_KEEP_DAYS
    duration_ms     INTEGER,
    size_bytes      INTEGER,
    parts           TEXT,                        -- JSON [{file, durationMs, sizeBytes}] once ready
    error           TEXT
  );
  CREATE INDEX recordings_expires ON recordings(expires_at);
  -- At most one live recording per Tank.
  CREATE UNIQUE INDEX recordings_one_per_tank ON recordings(tank_id) WHERE status = 'recording';
  `,

  /* 10: recording timer */ `
  ALTER TABLE recordings ADD COLUMN stop_at INTEGER;   -- set = stop automatically at this time
  `,

  /* 11: recordings shared to a Tank, to watch together there (docs/RECORDING.md, Phase 5) */ `
  CREATE TABLE tank_recordings (
    tank_id        TEXT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
    recording_id   TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    shared_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    shared_by_name TEXT NOT NULL,
    shared_at      INTEGER NOT NULL,
    PRIMARY KEY (tank_id, recording_id)
  );
  CREATE INDEX tank_recordings_recording ON tank_recordings(recording_id);
  `,

  /* 12: clips (the last minute of a live recording, saved on its own) */ `
  ALTER TABLE recordings ADD COLUMN kind TEXT NOT NULL DEFAULT 'recording' CHECK (kind IN ('recording', 'clip'));
  ALTER TABLE recordings ADD COLUMN source_id TEXT;   -- clips: the recording it was cut from (may be gone)
  `,
];

/** Small key/value store for server-generated secrets. */
export function getOrCreateSetting(db: DB, key: string, create: () => string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (row) return row.value;
  const value = create();
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value;
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = current; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
