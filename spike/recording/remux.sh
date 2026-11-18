#!/bin/sh
# Called by MediaMTX when a recording segment is complete.
# MTX_PATH = path name (the recording id), MTX_SEGMENT_PATH = the fMP4 file it wrote.
set -eu
case "$MTX_PATH" in *[!A-Za-z0-9_-]*|'') echo "remux: refusing path '$MTX_PATH'" >&2; exit 1;; esac
mkdir -p /recordings/ready
out="/recordings/ready/$MTX_PATH.mp4"
tmp="/recordings/ready/.$MTX_PATH.mp4.part"
start=$(date +%s)
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$MTX_SEGMENT_PATH" -c copy -movflags +faststart -f mp4 "$tmp"
mv "$tmp" "$out"
rm -f "$MTX_SEGMENT_PATH"
echo "remux: $out ready in $(( $(date +%s) - start ))s (segment ${MTX_SEGMENT_DURATION:-?})"
