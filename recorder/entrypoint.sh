#!/bin/sh
# FishTank recorder entrypoint: check the volume, finish any segment a crash left behind, then run
# MediaMTX. A clean stop needs no help: MediaMTX ends and remuxes the open segment itself
# (compose gives it a long stop_grace_period for that).
set -eu

if ! mkdir -p /recordings/raw /recordings/ready 2>/dev/null || [ ! -w /recordings/ready ]; then
  echo "recorder: /recordings is not writable by uid $(id -u). The fishtank-recordings volume (or the" >&2
  echo "recorder: RECORDINGS_PATH folder) must be writable by uid 1000; see docs/RECORDING.md." >&2
  exit 1
fi

# Raw segments still here at startup were never remuxed (crash or kill). fMP4 keeps every complete
# 1s part, so remuxing recovers the recording up to the crash.
for f in /recordings/raw/*/*.mp4; do
  [ -f "$f" ] || continue
  echo "recorder: recovering leftover segment $f"
  MTX_PATH=$(basename "$(dirname "$f")") MTX_SEGMENT_PATH="$f" sh /recorder/remux.sh \
    || echo "recorder: could not recover $f" >&2
done

exec /mediamtx /recorder/mediamtx.yml
