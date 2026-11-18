# Tank recording: plan

Status: **Phases 0–6 built** (6 = clips, deployed 2026-11-17). Waiting on live checks: watch together in a new Tank, a first real clip, a timer running out, and a longer recording on another device. Last updated 2026-11-17.

## Goal

An **admin** in a Tank can record it. Every FishTank **account** can watch the recording
afterwards until it is **automatically wiped 7 days** after it ends.

| Rule | Decision |
|---|---|
| Who can start/stop recording | Admins only, and only in a Tank they are in. Enforced on the server, and the button is hidden for everyone else. |
| Who can watch recordings | Every signed-in account (members and admins), whether or not they were in the Tank. **Not guests**: they are temporary and limited to their one Tank by the guest API allowlist. |
| How long recordings live | 7 days from when the recording **ends** (`RECORDING_KEEP_DAYS=7`), then the file and its row are deleted. Admins can delete earlier. No way to extend. |
| Who knows it is recording | Everyone in the Tank sees a red **REC** badge and a toast naming the admin who started it. People opening an invite link are told before joining. |
| Watch together in a Tank | Every finished recording can be played in any open Tank, from the Tank browser's Recordings page, so everyone in it watches together, guests included. Accounts can also send one to open there by itself (Phase 5). |
| Clips | While a Tank is recorded, any account in it (not guests) can save the last 60 s as a clip, kept and wiped like recordings (Phase 6). |
| Off by default | `RECORDING_ENABLED=false`. Nothing below runs (no recorder container work, no Neko broadcast settings) until a server owner turns it on. |

---

## How it works

```text
 Tank (Neko) ──RTMP 1935──► fishtank-recorder (MediaMTX)  ──writes──► recordings volume
      ▲   start/stop via Neko API          │  "may this stream publish?"        │
      │   (per-Tank API token)             ▼                                    │ reads, deletes
 fishtank-app ◄── GET /auth/recorder ──────┘                                    ▼
      │                                                              fishtank-app serves
      └── /api/recordings, /api/recordings/:id/video (Range) ──► browsers (accounts only)
```

1. An admin clicks **Record**. The app creates a `recordings` row with a random stream key
   (only a hash is stored) and calls the Tank's Neko:
   `POST /api/room/broadcast/start {"url": "rtmp://10.88.2.5:1935/<recordingId>?key=<key>"}`.
2. Neko encodes the screen and audio a second time (H.264 + AAC, FLV over RTMP) and pushes it
   to **MediaMTX**, an off-the-shelf RTMP server.
3. Before accepting the stream, MediaMTX asks the app (`GET /auth/recorder`, MediaMTX HTTP auth)
   whether that recording id and key are valid and currently recording. Anything else is refused,
   so a Tank can't publish without an active recording, or write into another recording.
4. MediaMTX writes the stream to disk. When the stream ends, a hook remuxes it (no re-encode,
   `ffmpeg -c copy -movflags +faststart`) into one MP4 file that browsers can seek in.
5. The app marks the recording **ready** and serves it to accounts with HTTP Range support. An
   hourly sweep deletes recordings whose `expires_at` has passed.

**Why this design**

- Neko already has broadcast built in, behind its API, so no `docker exec` is needed and the
  Docker gate stays unchanged (it doesn't restrict environment variables, so the broadcast
  settings pass through).
- The app already calls each Tank's Neko API with a per-Tank token (screenshots, logins).
  Broadcast is one more call of the same kind.
- MediaMTX is a single small binary with RTMP ingest, recording and HTTP auth hooks, so we don't
  write a media server.

### Confirmed from Neko's docs and source

- `POST /api/room/broadcast/start` with `{"url": "rtmp://..."}` (204; 422 if already
  broadcasting), `POST /api/room/broadcast/stop` (204; 422 if not broadcasting),
  `GET /api/room/broadcast` returns `{"url", "is_active"}`. All are **admin-only** in Neko.
- Settings: `NEKO_CAPTURE_BROADCAST_VIDEO_BITRATE` / `_AUDIO_BITRATE` (kbps), `_PRESET` (x264
  speed preset), `_PIPELINE`, `_URL`, `_AUTOSTART`, `_EMPTY_TIMEOUT` (default 0 = never stop).
- Default output: H.264 + AAC in FLV over RTMP. Only `rtmp://` is documented.
- On start and stop Neko sends a status event **to Neko admins only**, so its viewers get no
  indicator. FishTank must show its own.

### Phase 0 spike results (2026-11-16)

Run with `spike/recording/` (Neko `firefox:3`, MediaMTX `1.21.3-ffmpeg`, a logging auth stub),
6-CPU Tank limit, 720p30.

- [x] **The API bearer token is admin enough.** `GET/POST /api/room/broadcast[/start|/stop]` work
      with `Authorization: Bearer <NEKO_SESSION_API_TOKEN>`.
- [x] **Neko's default broadcast pipeline is unusable for playback.** It feeds RGB into x264, which
      picks **High 4:4:4 Predictive** (Firefox and Safari can't play it). It also records at 25 fps
      with a keyframe every 0.5 s. **Fix:** set `NEKO_CAPTURE_BROADCAST_PIPELINE` (see
      `spike/recording/docker-compose.yml`): `framerate=30/1`, `videoconvert ! format=I420`,
      `x264enc … key-int-max=60`, `profile=high`. Result: **H.264 High, yuv420p, 30 fps, a keyframe
      every 2 s**, AAC-LC stereo. When a pipeline is set, Neko ignores its `*_BITRATE`/`_PRESET`
      settings, so the app builds the pipeline string from `RECORDING_*`.
- [x] **CPU:** recording adds about **0.7 of a core** (0.3 → 1.05 cores, two rounds, steady motion
      test clip). Film-like content will cost somewhat more, around 1–1.5 cores. Real Tanks with viewers
      currently use about 1.7 cores, so live + recording fits well inside `TANK_CPUS=6`.
      *Still to check by eye:* watch a Tank live while it records, to confirm there's no stutter
      (the spike had no WebRTC viewer connected).
- [x] **MediaMTX HTTP auth** is a **POST** with JSON
      `{ip, user, password, token, action, path, protocol, id, query, userAgent}`, e.g.
      `action:"publish", path:"rec1", query:"key=…", ip:"10.88.4.129"` (the Tank's IP). A non-2xx
      reply refuses the stream. A wrong key and an unknown path were both refused.
- [x] **Playable and seekable:** `moov` before `mdat` (remux with `+faststart`), no decode errors,
      no audio gaps. It played and seeked to 30 s in Firefox. 4:2:0 High plays in Chrome and Safari too.
      Remux of a 90 s recording took about 1 s. *Still to check in Phase 2:* seeking through the
      app's Range responses.
- [x] **Tank removed mid-recording:** MediaMTX sees EOF at once, ends the segment and remuxes it.
      The file is complete up to the moment the container died.
- [x] **Disk:** 2.64 Mbit/s overall → about **1.2 GB per hour**.

**Surprises that change the plan:**

1. **Neko's status can't be trusted.** It reports `is_active: true` even when the recorder
   *refused* the stream, and again after the recorder restarted and **Neko never reconnected**.
   The app must track liveness from the recorder side (see Phase 1 hooks and Phase 2 watchdog).
2. **A resumed stream on the same path overwrote the first file.** Remux output must be unique per
   segment, and a recording can have more than one **part**.
3. **On restart, MediaMTX finishes and remuxes the open segment** (13 s test: fine). A long
   recording's remux takes longer, so the recorder needs a generous stop grace period, and a startup
   pass that remuxes any raw segment left behind by a crash.
4. **MediaMTX 1.21 also starts a MoQ server** (ports 8892/8893) unless `moq: false`. The config
   must turn off every protocol explicitly, and the image version must stay pinned.
5. Neko keeps capturing with nobody watching, so recording doesn't depend on viewers. A Tank
   still closes after `TANK_IDLE_MINUTES` with nobody connected, which ends its recording.

---

## Phases

### Phase 0: Spike (one evening)

Standalone, outside the main app, like `spike/`:

- `spike/recording/docker-compose.yml`: a MediaMTX container (pinned version, image with ffmpeg)
  and a Neko Tank on one network. Start the broadcast with `curl` against Neko's API.
- Work through the checklist above and write the results into this file.
- **Go/no-go:** the live stream stays smooth while recording at the chosen settings.

### Phase 1: Recorder service

`docker-compose.yml`:

```yaml
  recorder:
    image: bluenviron/mediamtx:<pinned>-ffmpeg
    container_name: fishtank-recorder
    restart: unless-stopped
    profiles: ["recording"]          # only started when recording is enabled
    volumes:
      - ./recorder/mediamtx.yml:/mediamtx.yml:ro
      - fishtank-recordings:/recordings
    networks:
      tanks:
        ipv4_address: 10.88.2.5      # fixed, outside the Tank range 10.88.2.128/25
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
```

- `recorder/mediamtx.yml` (start from `spike/recording/mediamtx.yml`):
  - RTMP on 1935 only. RTSP, HLS, WebRTC, SRT, **MoQ**, the API, metrics, pprof and the playback
    server are all explicitly off.
  - `authMethod: http` pointing at `http://10.88.2.2:3000/auth/recorder` (the app's fixed address on
    the Tank network). MediaMTX POSTs JSON (see the spike results).
  - Recording on, `recordFormat: fmp4`, `recordSegmentDuration` longer than `TANK_MAX_HOURS`,
    `recordDeleteAfter: 0s` (the app owns retention), `%z` in `recordPath`.
  - `runOnRecordSegmentComplete` remuxes to **`/recordings/ready/<id>/<segment-start>.mp4`** (unique
    per part), then removes the raw file.
  - `runOnAvailable` / `runOnUnavailable` (the 1.21 names; `runOnReady` / `runOnNotReady` are deprecated) tell the app when a recording's stream actually goes live and when
    it drops (`wget` POST to `/auth/recorder/event`, which Caddy never exposes).
- Container: `stop_grace_period: 2m` so a long recording's remux finishes on shutdown, and an
  entrypoint wrapper that remuxes leftover raw segments (from a crash) before starting MediaMTX.
- **Egress firewall:** with `RECORDING_ENABLED=true`, Tanks may also reach `10.88.2.5:1935`, and a
  second chain (`FISHTANK-RECORDER`) limits the recorder to replies plus `10.88.2.2:3000` (the app).
  Turning recording off removes the recorder hook.
- The app mounts `fishtank-recordings` at `/recordings` to serve and delete files.
- **Isolation:** the recorder is reachable from Tanks on one port only, has a read-only root
  filesystem and no capabilities, and can reach nothing but the app's auth endpoint. A Tank that
  gets compromised could attack MediaMTX, but it would land in a container with no access beyond
  the recordings volume.

**Phase 1 results (2026-11-17, live stack):**

- Files: `recorder/` (`mediamtx.yml`, `entrypoint.sh`, `remux.sh`, `event.sh`), the `recorder`
  service (profile `recording`) and the `fishtank-recordings` volume in `docker-compose.yml`, the
  recorder rules in `egress/egress.sh`, and `/recordings` owned by `node` in the app `Dockerfile`.
- Turning it on takes two `.env` lines: `COMPOSE_PROFILES=recording` and `RECORDING_ENABLED=true`.
- The recordings volume must be created by the **app image**, so it is owned by uid 1000 (the
  recorder's user). The recorder `depends_on` the app for that, and its entrypoint refuses to start
  with a clear message if the volume isn't writable.
- Verified live with a throwaway container in the Tank range (10.88.2.250):
  - It reaches the recorder on 1935 through the firewall. MediaMTX asks the app, and the stream is
    **refused** (the app has no `/auth/recorder` until Phase 2, so the safe default holds).
  - The Tank range is still blocked from the app and still has internet.
- Recorder checks: runs as uid 1000, read-only root, can write only to `/recordings`, listens on TCP
  1935 only, reaches the app's `/api/health`, and is **blocked** from the internet, the LAN and Tanks.
- Crash recovery: a leftover raw segment planted in `raw/` was remuxed into `ready/<id>/` on restart.
- **Not done yet:** the running app container doesn't mount `/recordings` yet (that needs an app
  recreate, which happens with the Phase 2 deploy).

### Phase 2: Server

**Config** (`config.ts`, `.env.example`, README table):

| Variable | Default | Purpose |
|---|---|---|
| `RECORDING_ENABLED` | `false` | Master switch. |
| `RECORDING_KEEP_DAYS` | `7` | Days after a recording ends before it is wiped. |
| `RECORDING_MAX_HOURS` | `TANK_MAX_HOURS` | Hard stop for one recording. |
| `RECORDING_VIDEO_KBPS` / `RECORDING_AUDIO_KBPS` | `2500` / `128` | Passed to Neko's broadcast encoder. |
| `RECORDING_PRESET` | `veryfast` | x264 speed preset (set from the spike). |
| `RECORDING_MIN_FREE_GB` | `10` | Refuse to start if the recordings disk has less free space. |
| `RECORDER_RTMP` | `rtmp://10.88.2.5:1935` | Where Tanks push. |
| `RECORDING_DIR` | `/recordings` | Mount point in the app. |

**Migration 9** (`db.ts`):

```sql
CREATE TABLE recordings (
  id            TEXT PRIMARY KEY,            -- uuid, also the MediaMTX path
  tank_id       TEXT REFERENCES tanks(id) ON DELETE SET NULL,
  tank_name     TEXT NOT NULL,               -- copied: shown after the Tank is gone
  started_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_by_name TEXT NOT NULL,             -- copied, like invite_log
  key_hash      TEXT NOT NULL,               -- sha256 of the stream key
  status        TEXT NOT NULL CHECK (status IN ('recording','processing','ready','failed')),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  expires_at    INTEGER,                     -- ended_at + RECORDING_KEEP_DAYS
  duration_ms   INTEGER,
  size_bytes    INTEGER,
  error         TEXT
);
CREATE INDEX recordings_expires ON recordings(expires_at);
CREATE UNIQUE INDEX recordings_one_per_tank ON recordings(tank_id) WHERE status = 'recording';
```

**Orchestrator** (`orchestrator.ts`; the fake in tests gains the same methods):

- `startBroadcast(tankId, apiToken, url)`, `stopBroadcast(tankId, apiToken)`,
  `broadcastStatus(tankId, apiToken)`.
- When recording is enabled, new Tanks get `NEKO_CAPTURE_BROADCAST_PIPELINE` in `Env`, built from
  `RECORDING_VIDEO_KBPS` / `_AUDIO_KBPS` / `_PRESET` (the 4:2:0, 30 fps, 2 s keyframe pipeline from the
  spike). There is **no** `_URL`/`_AUTOSTART`: the URL only exists while a recording runs.

**`recordings.ts`** (new `RecordingManager`, wired into `TankManager`):

- `start(tankId, adminId)`: checks that recording is enabled, the user is an admin and a live
  member of the Tank, nothing is already recording there, and there is enough free disk. Then it
  creates the row and key, calls `startBroadcast` and notifies everyone. If Neko fails, it marks
  the row failed and returns the error.
- **Start is confirmed by the recorder, not Neko.** If the recorder's `ready` event for that id
  doesn't arrive within ~10 s, the app stops the broadcast and marks the recording `failed`
  ("recorder unreachable").
- **Watchdog:** a `not ready` event the app didn't ask for (the recorder restarted or the network
  dropped) while the Tank is still open → stop and restart the Neko broadcast, which becomes the next
  **part** (up to 3 retries, then end the recording). Neko never reconnects on its own.
- `stop(recordingId, reason)`: calls `stopBroadcast`, sets `ended_at`/`expires_at` and status
  `processing`, then waits for the part files in `/recordings/ready/<id>/` (polled) and sets `ready`
  with total size and duration. It sets `failed` if no file appears within a few minutes.
- Parts: a `recording_parts` table (recording id, file name, start, duration, size), or a scan
  of the directory. Playback lists "Part 1, Part 2" only when there's more than one.
- Called from `TankManager.close()` **before** the container is removed, so a draining Tank ends
  its recording cleanly. Also used for the `RECORDING_MAX_HOURS` cutoff in the existing reaper loop.
- `authorizePublish(path, key, sourceIp)` for `/auth/recorder`: true only for a `recording` row
  with a matching key, from a Tank's own IP range.
- `sweep(now)` (hourly, next to the session purge): deletes files and rows past `expires_at`, plus
  orphan files with no row.
- On startup, `reconcile()`: rows stuck in `recording` whose Tank is gone go to `processing`
  (picked up if the file exists) or `failed`.

**Routes** (`routes/recordings.ts`; guests are already refused by the default-deny allowlist):

| Method + path | Who | Does |
|---|---|---|
| `POST /api/tanks/:id/recording` | admin in that Tank | Start |
| `DELETE /api/tanks/:id/recording` | admin in that Tank (or any admin) | Stop |
| `GET /api/recordings` | any account | List of `ready` / `processing` / live `recording`: Tank name, started by, start time, duration, size, `expires_at` |
| `GET /api/recordings/:id/video` | any account | The MP4 with Range support (`reply.sendFile`), `Cache-Control: private, no-store`, never public |
| `DELETE /api/recordings/:id` | admin | Wipe now (file + row) |
| `POST /auth/recorder` | MediaMTX only | Publish check (JSON body, see spike results). Under `/auth/*`, which Caddy already blocks from the internet. Also refuses callers not from the recorder's IP |
| `POST /auth/recorder/event` | MediaMTX only | `ready` / `not ready` per recording id, for start confirmation and the watchdog. Same restrictions |

Existing routes that change: the Tank detail includes `recording: { active, startedBy, startedAt }`,
and `/join/<code>` (share info) carries a "being recorded" flag for the guest join screen.

**Live events** (`realtime.ts`):

- `{ type: 'tank.recording', tankId, active, by }` to the Tank's members: drives the REC badge
  and the toast.
- `{ type: 'recordings.changed' }` to all account connections (not guests): refreshes the list
  when one becomes ready or is wiped.

**Phase 2 results (2026-11-17, deployed):**

- Files: `src/recordings.ts` (`RecordingManager`), `src/routes/recordings.ts` (account routes and
  the recorder hooks), migration 9 in `src/db.ts`, broadcast calls and the pipeline env in
  `src/orchestrator.ts`, `RECORDING_*` settings in `src/config.ts`, tests in
  `test/recordings.test.ts` (the fake orchestrator moved to `test/fake-orchestrator.ts`).
- Changes from the design above:
  - **Parts** are a JSON column on `recordings` (`parts`: file, duration, size), filled when the
    recording becomes ready. There's no separate table. Duration comes from each MP4's `mvhd` header.
  - **Start waits for the recorder.** `POST /api/tanks/:id/recording` returns once the recorder's
    `ready` event arrives (15 s limit), or 502 with the reason, so the button can show the real outcome.
  - **Every restart gets a new stream key** (only its hash is stored, so the app can't reuse the
    old one after its own restart). The old key stops working at once.
  - **Watchdog** reacts to an unexpected `notready` event, and also to the raw file not growing
    for 45 s (the recorder was killed and sent nothing). 3 restarts, then the recording ends. A
    stream that stays up 10 minutes gets its restarts back.
  - **Tanks opened before recording was on can't be recorded** (no pipeline in their env). The
    Tank detail says `supported: false`, and start returns 409.
  - **Stop:** any admin. **Failed** recordings (no file) are deleted at the next sweep.
  - Tank detail: `recording: { canRecord, supported, active: { id, startedBy, startedAt } | null }`
    (`null` when recording is off). Tank lists carry `recording: true/false`, the join page's
    code info carries `recording`, `/api/me` carries `features.recordings`, and
    `GET /api/recordings` adds `storage` (used/free bytes) for admins.
  - The app restarting doesn't interrupt a recording: Neko and the recorder carry on, and
    the app adopts it on startup. A recording whose Tank is gone goes to processing.
- Tests: 10 new (65 total, all passing). They cover:
  - who can start and stop
  - one recording per Tank
  - every hook refusal case
  - drain stopping the broadcast before the container goes
  - processing, Range playback (200/206/416) and wipe
  - guests and path tricks
  - an unconfirmed start
  - the watchdog (event, stall, give up)
  - the max-hours cutoff, reconcile, sweep and orphans
  - recording turned off
- Deployed: the app was recreated with the `/recordings` mount, and migration 9 was applied. The
  recordings volume was recreated by Compose; it was empty. Live checks:
  - A fake Tank (10.88.2.250) pushing to the recorder is **refused by the app** (403, logged as
    "recorder refused a stream").
  - The recorder's event call is accepted.
  - From the internet, `/auth/recorder*` return 404 (Caddy) and `/api/recordings` needs a login.
- **Not yet done live:** a real recording of a real Tank. Without the Phase 3 button it needs a
  hand-made API call, so it's the first thing to check once the UI exists (then the live-smoothness
  check from Phase 0).

### Phase 3: Web UI

- **Tank page:** a red **● REC 00:12:34** badge in the header for everyone while recording, and
  a toast "Recording started by *name*". Admins see **Record** / **Stop recording** in the side panel.
  Nobody else sees the controls.
- **Invite link / guest join screen:** "This Tank is being recorded" while it is.
- **Recordings page** (`/recordings`, new nav link for accounts): newest first, each with Tank
  name, who recorded it, date, length, and **"Deletes in 6 days"**. Clicking one opens a
  `<video controls>` player. Admins also get **Delete now**.
- **Home page:** Tank tiles show a small REC dot while recording.
- **Admin page:** live recordings (with Stop), disk use of the recordings volume, and the
  retention setting.

**Phase 3 results (2026-11-17, deployed):**

- **Stop timer** (added at the user's request): when starting, an admin picks *No timer*, *After
  30 min / 1 h / 2 h / 3 h*, or *At a time…* (a clock time; a time already past today means
  tomorrow). While recording, any admin can change or clear it.
  - Server: migration 10 adds `recordings.stop_at`. `POST /api/tanks/:id/recording` takes an
    optional `{ stopAt }` (epoch ms); `PATCH /api/tanks/:id/recording { stopAt | null }` changes it.
  - A stop time must be at least a minute ahead and within `RECORDING_MAX_HOURS` of the start.
  - The 5-second watchdog tick stops the recording when `stop_at` passes. The Tank detail's
    `active.stopAt` lets everyone in the Tank see when it ends.
- **Tank page:**
  - A red **● REC 12:34 · stops 9:30 PM** badge over the stream, for everyone in the Tank. There's
    also a dot on the collapsed side rail.
  - A **Record** card for admins, with the timer picker and the retention notice.
  - While recording, a **Recording** card shows who started it and when it stops, with
    Change timer and **■ Stop recording** (admins only).
  - A toast for everyone in the Tank when recording starts or stops.
- **Recordings page** (`/recordings`, nav link for accounts when recording is on):
  - newest first, with length, size, parts and **"Deletes in N days"**
  - live and processing entries
  - a `<video>` player at `/recordings/<id>` with part tabs when there's more than one
  - **Delete now** for admins
- **Home:** a REC tag on Tank tiles. **Guest join screen:** a red "This Tank is being recorded"
  warning. **Admin page:** a REC tag in Live Tanks, plus a Recordings card (count, used and free
  disk, retention, live recordings, and a low-space warning).
- 66 server tests pass (1 new for the timer). The web app typechecks and builds.

### Phase 4: Tests, docs, rollout

**Tests** (`node:test`, fake orchestrator):

- A member (non-admin), guest or non-member admin can't start recording (403). An admin member can.
- One active recording per Tank. A second start returns 409.
- Every account, including ones not in the Tank, can list and play. Guests get 403 on all
  recording routes, including path tricks (`//`, `%2F`, case).
- Range requests return 206 with the right byte ranges.
- `/auth/recorder` accepts only an active id + key from the Tank range, and refuses wrong keys,
  ended recordings and other source IPs.
- Draining a Tank stops its recording before the container is destroyed. The max-hours cutoff works.
- `sweep` wipes exactly the expired rows and files (fake clock), and removes orphan files.
- Startup reconcile of stuck recordings.
- With `RECORDING_ENABLED=false`, routes return 404 and no broadcast env goes to Tanks.

**Live verification:** record a real Tank for about 10 minutes and play it on another device.
Check that a second Tank can't publish to it, that the recorder is unreachable from a Tank on any
other port, that the file is gone after a forced expiry, and that the live stream stays smooth on
the Admin page CPU graph.

**Docs:** README sections for enabling recording, the new settings, disk sizing, the privacy
notice below, and a note on recording third-party content.

#### First live recording (2026-11-17)

A real Tank, opened after recording was enabled, recorded end to end from the web UI:

- An admin pressed Record with a 30-minute timer. The recorder had the stream about 2 s later.
- The admin stopped it by hand after 38 s. It was ready to play about 2 s after that: one part,
  38.1 s, 8.0 MB (about 1.7 Mbit/s).
- It played and seeked in the browser. The admin reported the live stream looked fine while recording.
- No watchdog restarts, refusals or errors in the logs.

#### Isolation checks (2026-11-17)

Run from a throwaway container at a Tank address (10.88.2.250):

| From a Tank address to | Result |
| --- | --- |
| Recorder RTMP `10.88.2.5:1935` | open (the one allowed port) |
| Recorder `8554`, `8888`, `8889`, `8890`, `9996`, `9997` | blocked |
| App `10.88.2.2:3000`, Docker host, LAN router | blocked |
| Public internet | open (as for every Tank) |
| RTMP publish to a made-up recording id with a forged key | refused ("authentication failed"); the app logged the refusal with the source IP |

From the recorder: the app (`10.88.2.2:3000`) is open, while the internet and the LAN are blocked.

**Forced expiry (2026-11-17):** a throwaway recording (a copy of the first one) was given an
`expires_at` 1 minute in the past. The next hourly sweep deleted its row and folder ("expired
recordings wiped", count 1). The real recording was untouched.

**Tests:** every item in the list above is covered in `apps/server/test/recordings.test.ts`.

**Docs:** README now covers disk sizing, CPU, the privacy notice, other people's content, and a
recording line in the security model.

Still open (needs a person at a browser):

- A timer running out on a real Tank. This is covered by the tests but not yet seen live.
- A longer recording, about 10 minutes, played on another device and seeked.

### Phase 5: Watch a recording together in a Tank

**Goal:** someone in an open Tank plays a recording *in* the Tank, so everyone there watches it
together, with the Tank's usual control, chat and sound. This includes guests, the same as
anything else on the shared screen.

**Who:** any account (member or admin) that is in the Tank. Guests can't choose a recording,
because they can't see the list, but they see it play.

**How it works:**

```text
 Account: "Share to Tank" ──► app remembers: Tank T may play recording R
 Tank T's Firefox (Recordings bookmark) ──HTTP──► app, port 3001 (Tank side only) ──► page + video for R
                     (who's asking = the open Tank with that container IP)
```

1. **Choosing:** a **Play in this Tank** button in two places:
   - the Recordings player, with a choice of the open Tanks you're in;
   - a **Recordings** list in the Tank's side panel.

   The app records the choice in a new `tank_recordings` table
   (`tank_id, recording_id, shared_by, shared_at`). Rows are removed when the Tank closes or the
   recording is wiped. If guests are in the Tank, the button says so first ("Guests in this Tank
   will see it too").
2. **A Tank-only port:** the app listens on a second port, `10.88.2.2:3001`. It serves only:
   - `GET /`: the recordings shared to this Tank, newest first;
   - `GET /r/<id>`: a full-window player;
   - `GET /r/<id>/video?part=N`: the file, with Range support, as in Phase 2.

   Nothing else is on this port: no API, no cookies, no tokens. The caller is identified by
   source IP, which must be the container IP of an **open** Tank. Anyone else gets 404.
   A recording must have been shared to *that* Tank. So the address is useless outside the
   Tank, and copying it out of the address bar gets a guest nothing.
3. **Firewall:** egress adds one allow rule, Tank range → `10.88.2.2:3001`, only when recording
   is on. Port 3000 (the real app) stays blocked for Tanks.
4. **Getting the Tank's browser there:** Neko has no "open this page" call, and its clipboard API
   refuses the API token (403, spike below). So, with recording on, the Tank's Firefox gets two
   extra things when it starts:
   - a **Recordings** tile on its start page and on the bookmarks bar;
   - autoplay permission for that page (Firefox policy `Permissions.Autoplay.Allow`).

   Someone with control opens it once. After that, a newly shared recording opens and starts by
   itself, because the page checks for new shares every 3 s. Tanks opened before Phase 5 have no
   bookmark, so type `http://10.88.2.2:3001` instead.
5. **Ending:** when a recording expires or is deleted, it drops off the Tank page and its
   file stops being served, even mid-play. Closing the Tank removes its shares.

**Trade-offs:**

- The Tank captures and encodes the video a second time, so the picture is a little softer than
  the original. That's fine at 720p.
- Decoding costs some of the Tank's CPU.
- If the Tank is also being recorded, the playback ends up in the new recording.

**Considered instead:** a player in each viewer's own browser, laid over the Tank and kept in
sync (play, pause, seek) through the realtime socket.

- **Better:** original quality, and no Tank CPU.
- **Worse:** it needs a sync engine, has to give guests direct access to the file, and fights
  the Tank's own sound. It could be added later on top of the same "shared to this Tank" rows.

**Checked already (2026-11-17):** the Tank image (`neko/firefox:3`) ships `libavcodec` and
OpenH264, so its Firefox can decode our H.264/AAC MP4s.

**Spike (2026-11-17):** Neko's `POST /api/room/clipboard` returns **403** with the API token,
tested on a throwaway Neko with no network. It needs a host session, so the bookmark approach
above replaced it.

**Built (2026-11-17):**

- **Data:** migration 11 adds `tank_recordings`. Rows go when the Tank closes, and when the
  recording is wiped or expires (cascade).
- **API** (accounts in the Tank; guests get 403 from the allowlist):
  `POST /api/tanks/:id/playback {recordingId}` and `DELETE /api/tanks/:id/playback/:recordingId`.
- **Tank details:** now include `canShare`, `tankUrl` and `shared`.
- **Realtime:** a `tank.playback` event pops up a toast for everyone in the Tank.
- **Tank-side server** (`apps/server/src/tankplayback.ts`):
  - a separate Fastify instance on `RECORDING_TANK_HOST:RECORDING_TANK_PORT` (compose binds it
    to `10.88.2.2:3001`, the Tank network only);
  - `trustProxy` off, and a strict CSP (scripts from itself only);
  - it looks up each caller's open Tank by its container IP, using Docker inspect through the
    gate, cached until the Tank closes;
  - it serves `/`, `/r/<id>`, `/shared.json`, `/r/<id>/video` (Range), `/tank.js` and `/tank.css`;
  - a recording in several parts plays them one after another.
- **Egress:** one rule, Tank range → `10.88.2.2:3001`, only with recording on.
- **Web:**
  - a **Watch together** card in the Tank side panel: pick a recording, share it, play it
    again, remove it, with a confirmation when guests are present;
  - **Play in Tank** on the Recordings player;
  - the toast.
- **Tests:** 2 new, 68 in total.
- **Live checks after deploy:**
  - From a non-Tank address in the Tank range, port 3001 is reachable but answers 404.
  - Port 3000 is still blocked for Tanks.

**Changed 2026-11-17 (owner's request):** sharing is no longer required. The Tank-side page
lists **every** ready recording, and any open Tank can play any of them. Sharing became
**Open in Tank**, which only makes a recording open by itself on that Tank's page. The
"shared to this Tank" list and its Remove button are gone from the UI. The API and table stay,
and they drive the auto-open. So guests in a Tank can see any recording that someone with control
plays there. They still can't list recordings on the site.

**Still to check live:** open a new Tank, share the first recording, and open Recordings in the
Tank's browser. Check that:

- it autoplays with sound and stays smooth for viewers;
- seeking works;
- sharing another recording switches over by itself;
- the CPU on the Admin graph looks reasonable.

**Tests:**

- Port 3001 answers only open Tank IPs, and only for recordings shared to that Tank.
- It serves no `/api` routes.
- Guests can't share a recording, and accounts not in the Tank can't share to it.
- Shares are removed when the Tank closes or the recording is wiped.
- With recording off, nothing listens on 3001.


### Phase 6: Clips (built 2026-11-17)

**Goal:** a **✂ Clip the last minute** button. Anyone with an account in a Tank that is being
recorded can press it. Guests can't, because their API allowlist refuses it.

**How it works:**

1. The recorder already writes the live recording as fMP4 in 1 s parts. MediaMTX's own
   **playback server** (`playback: true`, `:9996`) serves a time range of that as an MP4,
   without re-encoding.
2. `POST /api/tanks/:id/clip` → `RecordingManager.clip()`:
   - asks the recorder `/list?path=<recording>` for the spans it has;
   - takes the last `RECORDING_CLIP_SECONDS` (default 60) of the newest span;
   - downloads `/get?…&format=mp4` to `ready/<clipId>/clip.mp4`, through a hidden `.part` file
     and a rename.
3. The clip is a row in `recordings` (migration 12: `kind = 'clip'`, plus `source_id`):
   status `ready`, started at the clip's first second, expiring `RECORDING_KEEP_DAYS` after it
   was made. Everything else (list, player, playing in Tanks, wipe, sweep) treats it like a recording.
4. **Lock-down:** every playback request goes through the app's auth hook (`action: "playback"`).
   The hook accepts only user `fishtank-app` with a password the app generates in memory at
   startup, and only for a recording that is live right now. Tanks can't reach `:9996`, because
   egress allows only `:1935` there.

**Spike (2026-11-17):** a throwaway MediaMTX 1.21.3 got a 90 s test stream. The last 60 s were
requested *while it was still recording*. Result: 60.03 s, H.264 High 4:2:0 + AAC-LC, decoded
cleanly, with `moov` at the front, so it can be seeked straight away. Cuts snap to a keyframe
(every 2 s).

**Verified after deploy:**

- The recorder logs `[playback] started`.
- From the app, no credentials or a wrong password gets 401.
- From a Tank address, `:9996` is blocked and `:1935` is open.
- Migration 12 is applied.
- Tests: 69, including one clip test. It covers:
  - members (not just admins) can clip; guests get 403 and outsiders 404;
  - not recording, or under 2 s recorded, gets 409;
  - a recorder failure gets 502 and leaves no file or row behind;
  - the hook refuses wrong passwords;
  - the clip outlives its recording.

**First live clip (2026-11-17):** in a new Tank, the clip was pressed 37 s after Record. It
saved 31.9 s (everything recorded so far, snapped to a keyframe) and 2.4 MB, and it played back
well. The owner confirmed it. No errors in the logs.

**Limits:**

- Clips only work while recording.
- One clip at a time per Tank.
- Clips are rate-limited to 12 per person per 10 minutes.
- If the stream dropped and resumed in the last minute, the clip covers only the time since it resumed.

---

## Privacy and legal

- A recording keeps everything on the Tank's screen: logged-in accounts, emails, chat windows.
  This changes FishTank's "everything is destroyed" promise, so recording is off by default,
  admin-only, always visibly announced, and time-limited.
- Anyone who can play a recording can save a copy (as with any web video). The 7-day wipe deletes
  the server's copy only. The UI and README should say so.
- Recording your own media (Jellyfin/Plex libraries) is fine. Recording YouTube, Twitch or other
  services' content goes against their terms of service and may infringe copyright. The README
  leaves that decision to each server owner.
- Only the Tank's own audio and video are captured. Voice chat in Discord etc. is not.

## Open questions

1. Should Tank members who **aren't** admins at least be able to **ask** for a recording, or
   stop one they're in? (Plan: no. Admin only.)
2. Should playback be limited to people who were **in** the Tank? (Plan: no, every account, as requested.)
3. Should the 7 days count from the **end** of the recording (plan) or the start? END
4. Should there be a storage cap (e.g. 50 GB) that refuses new recordings when it's full, in
   addition to the free-disk check?
