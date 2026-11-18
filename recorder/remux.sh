#!/bin/sh
# Remux one finished recording segment into a seekable MP4 (no re-encode).
# MediaMTX sets MTX_PATH (the recording id) and MTX_SEGMENT_PATH (the raw fMP4 segment).
# Output: /recordings/ready/<id>/<segment name>.mp4. One file per segment, so a recording that
# resumes after a dropped stream gets a second part instead of overwriting the first.
set -eu

case "${MTX_PATH:-}" in ''|*[!A-Za-z0-9_-]*) echo "remux: refusing path '${MTX_PATH:-}'" >&2; exit 1;; esac
case "$MTX_SEGMENT_PATH" in /recordings/raw/"$MTX_PATH"/*) ;; *) echo "remux: unexpected segment '$MTX_SEGMENT_PATH'" >&2; exit 1;; esac

dir="/recordings/ready/$MTX_PATH"
name=$(basename "$MTX_SEGMENT_PATH" .mp4)
out="$dir/$name.mp4"
tmp="$dir/.$name.mp4.part"
mkdir -p "$dir"

start=$(date +%s)
if ffmpeg -nostdin -hide_banner -loglevel error -y -i "$MTX_SEGMENT_PATH" -c copy -movflags +faststart -f mp4 "$tmp"; then
  mv "$tmp" "$out"
  rm -f "$MTX_SEGMENT_PATH"
  rmdir "/recordings/raw/$MTX_PATH" 2>/dev/null || true
  echo "remux: $out ready in $(( $(date +%s) - start ))s"
else
  rm -f "$tmp"
  echo "remux: FAILED for $MTX_SEGMENT_PATH (raw segment kept)" >&2
  exit 1
fi
