FROM node:22-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Chromium only (no firefox/webkit), its system deps, and Xvnc + noVNC so the
# headful browser is viewable from a web browser (published loopback-only).
RUN npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends tigervnc-standalone-server novnc websockify \
    && rm -rf /var/lib/apt/lists/*

COPY core/ core/
COPY help/ help/
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8931 PLUGINS_DIR=/plugins DATA_DIR=/data PROFILES_DIR=/profiles HEADLESS=0 KIOSK=0
EXPOSE 8931 8932 6080
ENTRYPOINT ["/entrypoint.sh"]
