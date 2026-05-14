# ============================================
# Multi-stage Dockerfile for PAA Worker Service
# Pattern Analysis Agent - Kafka Consumer
# ============================================

# Stage 1: Builder
FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ============================================
# Stage 2: Production
# ============================================
FROM node:20-slim AS production

# Install runtime dependencies
RUN apt-get update && apt-get install -y curl tini && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/bash nodejs

WORKDIR /app

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# Switch to non-root user
USER nodejs

# Environment variables
ENV NODE_ENV=production
ENV METRICS_PORT=9090
ENV LOG_LEVEL=info

# Expose metrics port
EXPOSE 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:9090/health || exit 1

# Use tini as init process. `apt-get install tini` on Debian places
# the binary at /usr/bin/tini; /sbin/tini is the Alpine convention.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the worker
CMD ["node", "dist/worker.js"]
