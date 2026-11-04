# One container, one public port: the backend serves the built web app and talks to the connector and the AI service on localhost.
# Built for free hosting (Hugging Face Spaces: Docker SDK, port 7860, uid 1000), but runs anywhere Docker does.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json package-lock.json tsconfig.base.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps ./apps
RUN chown node:node /app

USER node
RUN npm ci && npm run build -w @meetpilot/web \
    && python3 -m venv /home/node/venv && /home/node/venv/bin/pip install --no-cache-dir -r apps/ai/requirements.txt

COPY --chown=node:node infra/deploy ./infra/deploy

ENV NODE_ENV=production \
    PATH="/home/node/venv/bin:$PATH" \
    BACKEND_PORT=7860 \
    WEB_DIST=/app/apps/web/dist \
    AI_URL=http://127.0.0.1:5001 \
    CONNECTOR_URL=http://127.0.0.1:6100

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fs http://127.0.0.1:7860/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "infra/deploy/entrypoint.sh"]
