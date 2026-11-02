FROM node:22-bookworm-slim
WORKDIR /app
COPY services/browser/package.json ./services/browser/package.json
RUN cd services/browser && npm install --omit=dev --no-audit --no-fund
COPY services/browser/ ./services/browser/
COPY poc/smoke1/browserbase.mjs ./poc/smoke1/browserbase.mjs
WORKDIR /app/services/browser
CMD ["node", "server.mjs"]
