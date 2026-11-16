#!/bin/sh
# FishTank Tank egress firewall.
#
# Runs in the Docker host's network namespace (on Docker Desktop: its Linux VM) and adds
# rules to the DOCKER-USER chain so Tank containers can reach the public internet but NOT
# private networks: your LAN and router, the Docker host (host.docker.internal), or other
# containers. Exceptions: DNS, replies to connections opened *to* the Tank (Caddy, the app),
# and an explicit allowlist (e.g. Plex/Jellyfin).
#
# Rules stay in place if this container stops (fail closed). They are re-checked every 30s
# and re-applied if Docker restarts and resets DOCKER-USER.
set -eu

IPT=iptables-nft                       # Docker Desktop's VM uses the nft backend
SRC="${TANK_SOURCE_RANGE:?set TANK_SOURCE_RANGE (e.g. 10.88.2.128/25)}"
ALLOW="${ALLOW_DESTINATIONS:-}"        # space-separated ip:port (TCP)
CHAIN=FISHTANK-EGRESS
PRIVATE="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16"

build_chain() {
  $IPT -N "$CHAIN" 2>/dev/null || $IPT -F "$CHAIN"
  $IPT -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  $IPT -A "$CHAIN" -p udp --dport 53 -j RETURN
  $IPT -A "$CHAIN" -p tcp --dport 53 -j RETURN
  for a in $ALLOW; do
    $IPT -A "$CHAIN" -d "${a%:*}" -p tcp --dport "${a##*:}" -j RETURN
  done
  for net in $PRIVATE; do
    $IPT -A "$CHAIN" -d "$net" -j REJECT --reject-with icmp-admin-prohibited
  done
  echo "egress: chain $CHAIN built (allow: ${ALLOW:-none})"
}

ensure_hook() {
  if ! $IPT -C DOCKER-USER -s "$SRC" -j "$CHAIN" 2>/dev/null; then
    $IPT -N DOCKER-USER 2>/dev/null || true
    $IPT -I DOCKER-USER 1 -s "$SRC" -j "$CHAIN"
    echo "egress: hooked $SRC into DOCKER-USER"
  fi
}

build_chain
ensure_hook
trap 'echo "egress: stopping (rules left in place)"; exit 0' TERM INT
while true; do
  sleep 30 & wait $!
  $IPT -S "$CHAIN" >/dev/null 2>&1 || build_chain
  ensure_hook
done
