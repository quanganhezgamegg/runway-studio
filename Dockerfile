# syntax=docker/dockerfile:1

# ---------- Giai doan 1: build frontend ----------
FROM node:24-alpine AS web

WORKDIR /build

# Cai dependency truoc de tan dung layer cache khi chi doi ma nguon
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci --no-audit --no-fund

# catalog.json duoc sinh tu spec, frontend build khong can no
# nhung check:routing thi can - copy ca hai cho day du
COPY scripts/ ./scripts/
COPY spec/ ./spec/
RUN mkdir -p public && node scripts/build-catalog.mjs

COPY web/ ./web/
RUN cd web && npm run build


# ---------- Giai doan 2: runtime ----------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

WORKDIR /app

# Chi cai dependency cua server (express), khong keo theo toolchain frontend
COPY package.json package-lock.json* ./
# --ignore-scripts: package.json co postinstall chay build-catalog, nhung
# scripts/ va spec/ chua duoc copy vao o buoc nay. catalog.json lay san
# tu giai doan web ben duoi nen khong can chay lai.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force

COPY server.mjs ./
COPY scripts/ ./scripts/
COPY spec/ ./spec/

# catalog.json + frontend da build tu giai doan truoc
COPY --from=web /build/public/catalog.json ./public/catalog.json
COPY --from=web /build/public/dist ./public/dist

# data/ va outputs/ gan volume o docker-compose de song qua lan build lai
RUN mkdir -p data outputs && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/me').then(r=>process.exit(r.status===401||r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
