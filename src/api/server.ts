import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ensureStorage } from '../storage.js';
import { getBoss, stopBoss } from '../pipeline/queues.js';
import { disconnect } from '../db.js';
import { authenticate } from './auth.js';
import { recordingRoutes } from './routes/recordings.js';
import { conversationRoutes } from './routes/conversations.js';
import { searchRoutes } from './routes/search.js';
import { kbRoutes } from './routes/kb.js';
import { workspaceRoutes } from './routes/workspace.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { browseRoutes, devUsersRoute } from './routes/browse.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Recall API (PRD §11). Internal JSON. Standard error shape
 * { ok:false, code, message, field? }. Auth + Financial/Legal filtering applied
 * server-side on every scoped route via the `authenticate` preHandler.
 */
export async function buildServer() {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 2 * 1024 * 1024 });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: config.UPLOAD_MAX_BYTES } });

  // Optional HTTP Basic gate for public deployments (PRD: real per-user auth is
  // Phase 2). Applies to every route except /health (so platform health checks
  // and uptime pings still work). No-op locally when BASIC_AUTH is unset.
  if (config.BASIC_AUTH) {
    const expected = 'Basic ' + Buffer.from(config.BASIC_AUTH).toString('base64');
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/health') return;
      if (req.headers.authorization === expected) return;
      reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="Recall (internal review)"')
        .send({ ok: false, code: 'UNAUTHENTICATED', message: 'authentication required' });
    });
  }

  // Standard error envelope for unexpected throws.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error({ err }, 'unhandled route error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      ok: false,
      code: status === 500 ? 'SERVER_ERROR' : 'VALIDATION_FAILED',
      message: status === 500 ? 'internal error' : err.message,
    });
  });

  // Public: health, the dev-users list (role switcher), and the dashboard SPA.
  await app.register(async (publicScope) => {
    await healthRoutes(publicScope);
    await devUsersRoute(publicScope);
    // Resolve from CWD (project root in dev, /app in Docker) so the same code
    // works compiled (dist/src/api) and via tsx (src/api).
    const indexPath = join(process.cwd(), 'public', 'index.html');
    publicScope.get('/', async (_req, reply) => {
      const html = await readFile(indexPath, 'utf8');
      return reply.type('text/html').send(html);
    });
  });

  await app.register(async (scoped) => {
    scoped.addHook('preHandler', authenticate);
    await recordingRoutes(scoped);
    await conversationRoutes(scoped);
    await searchRoutes(scoped);
    await kbRoutes(scoped);
    await workspaceRoutes(scoped);
    await adminRoutes(scoped);
    await browseRoutes(scoped);
  });

  return app;
}

async function start() {
  await ensureStorage();
  await getBoss(); // ensure queues exist so the API can enqueue
  const app = await buildServer();
  // Hosting platforms (Render/Railway/Fly) inject $PORT — honor it, else APP_PORT.
  const port = Number(process.env.PORT) || config.APP_PORT;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info(`Recall API listening on :${port}`);

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'API shutting down');
    await app.close();
    await stopBoss();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Auto-start unless imported by a test (set RECALL_NO_START=1 in that case).
if (process.env.RECALL_NO_START !== '1') {
  start().catch((err) => {
    logger.error({ err }, 'API failed to start');
    process.exit(1);
  });
}
