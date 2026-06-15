# Production image for Recall — used for BOTH the API and the worker service
# (same image, different start command). Works on Render / Railway / Fly / any VPS.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# openssl is needed by Prisma's query engine on slim images
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts ./scripts

# API listens on $APP_PORT (platforms inject $PORT — map it in render.yaml/env).
EXPOSE 3000
# Default command runs the API; the worker service overrides this with
# `node dist/src/worker/main.js`. Migrations/extras/seed run once via the API's
# release/pre-deploy step (see render.yaml) so both services start clean.
CMD ["node", "dist/src/api/server.js"]
