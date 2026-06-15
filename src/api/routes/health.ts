import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { lastBeat } from '../../worker/heartbeat.js';
import { resolveEngineName } from '../../adapters/transcription/index.js';

/**
 * /health (PRD §11, REQ-16.1): DB, queue, last worker tick, engine reachability.
 * No auth — used by uptime checks. Flags the worker stale if its last heartbeat
 * is older than the configured threshold (default 5 min).
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const checks: Record<string, unknown> = {};
    let ok = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = 'ok';
    } catch (err) {
      ok = false;
      checks.db = `error: ${(err as Error).message}`;
    }

    try {
      const beat = await lastBeat();
      if (!beat) {
        checks.worker = 'no heartbeat yet';
      } else {
        const ageMs = Date.now() - beat.getTime();
        const stale = ageMs > config.WORKER_HEARTBEAT_STALE_MS;
        checks.worker = stale ? `stale (${Math.round(ageMs / 1000)}s)` : 'ok';
        checks.worker_last_tick = beat.toISOString();
        if (stale) ok = false;
      }
    } catch (err) {
      checks.worker = `error: ${(err as Error).message}`;
    }

    try {
      const depth = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM pgboss.job WHERE state IN ('created','retry','active')
      `;
      checks.queue_depth = Number(depth[0]?.count ?? 0);
    } catch {
      checks.queue_depth = 'unavailable';
    }

    checks.transcription_engine = await resolveEngineName().catch(() => 'unknown');

    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });
}
