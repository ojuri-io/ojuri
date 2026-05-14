# ============================================
# Multi-stage Dockerfile for Fraud Detection Service
# Supports both RDA and PAA modes
# ============================================

# Stage 1: Builder
FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for building)
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
# dist/database/index.js requires('../../knexfile') — must sit alongside dist/.
COPY --from=builder --chown=nodejs:nodejs /app/knexfile.js ./knexfile.js

# Create directories for models and data
RUN mkdir -p /app/models /app/.kafka-buffer && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Environment variables with defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV LOG_LEVEL=info

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/livez || exit 1

# Use tini as init process
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the application
CMD ["node", "dist/server.js"]
