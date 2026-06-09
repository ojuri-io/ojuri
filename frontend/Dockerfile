# ============================================
# Multi-stage Dockerfile for Sentinel (operator dashboard)
# ============================================

# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# The dev server proxies /v1/* -> RDA and /fia/* -> FIA in development.
# In a production image, the SPA is static; adopters point the
# fronting reverse-proxy (their own ingress) at the same upstreams.
RUN npm run build

# ============================================
# Stage 2: Static serve via nginx
# ============================================
FROM nginx:1.27-alpine AS production

RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/dist /usr/share/nginx/html

# Drop a minimal config that serves the SPA with HTML5-history
# fallback (every unknown route returns index.html so client-side
# routing works on hard refresh). Adopters fronting Sentinel with
# their own ingress can mount their own config over this.
RUN printf '%s\n' \
    'server {' \
    '  listen 80 default_server;' \
    '  root /usr/share/nginx/html;' \
    '  index index.html;' \
    '  location / { try_files $uri $uri/ /index.html; }' \
    '  # Cache hashed assets aggressively; Vite emits content-hashed' \
    '  # filenames so this is safe.' \
    '  location ~* \.(?:js|css|woff2?|png|jpg|svg|ico)$ {' \
    '    expires 7d;' \
    '    add_header Cache-Control "public, immutable";' \
    '  }' \
    '}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
