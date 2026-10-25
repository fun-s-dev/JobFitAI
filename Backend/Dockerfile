# ==============================================================================
# Stage 1: Dependency resolution and production install
# ==============================================================================
FROM node:22-slim AS deps
WORKDIR /app

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
COPY package*.json ./
RUN npm ci --omit=dev

# ==============================================================================
# Stage 2: Runtime image (multi-stage, non-root, optional Chromium)
# ==============================================================================
FROM node:22-slim AS runner
WORKDIR /app

# Chromium is OPTIONAL via build arg INSTALL_CHROMIUM (default false)
ARG INSTALL_CHROMIUM=false
ENV INSTALL_CHROMIUM=${INSTALL_CHROMIUM} \
    NODE_ENV=production \
    PORT=3000

# Install Chromium only when explicitly opted in via build arg
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-ipafont-gothic \
        fonts-wqy-zenhei \
        fonts-thai-tlwg \
        fonts-kacst \
        fonts-freefont-ttf \
        libxss1 \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Configure Puppeteer executable path if Chromium is installed
ENV PUPPETEER_EXECUTABLE_PATH=${INSTALL_CHROMIUM:+"/usr/bin/chromium"}

# Copy production node_modules from deps stage and application code
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# Run as non-root user for security hardening
USER node

EXPOSE 3000

# Liveness healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "server.js"]
