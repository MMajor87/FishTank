FROM node:24-alpine
WORKDIR /gate
COPY policy.mjs gate.mjs ./
# Runs as root only because the Docker socket is root-owned; the container is read-only,
# has no capabilities, and sits on an internal network reachable only by the FishTank app.
CMD ["node", "gate.mjs"]
