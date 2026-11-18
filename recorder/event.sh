#!/bin/sh
# Tells the app that a recording's stream became ready / not ready (MediaMTX runOnAvailable /
# runOnUnavailable). The app uses it to confirm a start and to resume a dropped recording, because
# Neko keeps reporting "broadcasting" even when the stream is gone.
# Best effort: the app also notices missing files, so a failed call is only logged.
set -u

case "${1:-}" in ready|notready) ;; *) echo "event: bad event '${1:-}'" >&2; exit 1;; esac
case "${MTX_PATH:-}" in ''|*[!A-Za-z0-9_-]*) echo "event: refusing path '${MTX_PATH:-}'" >&2; exit 1;; esac

wget -q -T 5 -O /dev/null \
  --header 'Content-Type: application/json' \
  --post-data "{\"event\":\"$1\",\"path\":\"$MTX_PATH\"}" \
  http://10.88.2.2:3000/auth/recorder/event \
  || echo "event: could not tell the app '$1' for $MTX_PATH" >&2
