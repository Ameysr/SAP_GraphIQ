# ── Backend Dockerfile ─────────────────────────────────────────────────────────
# Multi-stage build: compile TypeScript → slim production image

# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npx tsc

# Stage 2: Production
FROM node:20-alpine AS production
WORKDIR /app

# Only install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JS + config
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/server.js"]
