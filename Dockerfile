# ---- build the web UI ----
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web
COPY apps/web apps/web
RUN npm run build -w apps/web

# ---- runtime: server runs TypeScript directly (Node type stripping), no build step ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/fishtank.sqlite \
    WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w apps/server && npm cache clean --force
COPY apps/server/src apps/server/src
COPY --from=web /app/apps/web/dist apps/web/dist
# /recordings: the app image creates the recordings volume, so it is owned by node (uid 1000),
# which the recorder also runs as.
RUN mkdir -p /data /recordings && chown node:node /data /recordings
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]
