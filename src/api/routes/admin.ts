import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { audit } from '../../audit.js';
import { requireActor, forbidden } from '../auth.js';
import { canManageConfig, isAdmin } from '../../services/permissions.js';
import { ENGINE_CONFIG_KEY, listEngines, resolveEngineName } from '../../adapters/transcription/index.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── F10: engine config get/set ────────────────────────────────────────────
  app.get('/admin/engine-config', async (req, reply) => {
    const actor = requireActor(req);
    if (!canManageConfig(actor)) return forbidden(reply, 'config role required');
    const engine = await resolveEngineName();
    return reply.send({ ok: true, transcription_engine: engine, available: listEngines() });
  });

  app.post<{ Body: { engine: string } }>('/admin/engine-config', async (req, reply) => {
    const actor = requireActor(req);
    if (!canManageConfig(actor)) return forbidden(reply, 'config role required');
    const engine = req.body.engine;
    if (!listEngines().includes(engine)) {
      return reply.code(400).send({ ok: false, code: 'VALIDATION_FAILED', message: `unknown engine '${engine}'`, field: 'engine' });
    }
    await prisma.engineConfig.upsert({
      where: { key: ENGINE_CONFIG_KEY },
      create: { key: ENGINE_CONFIG_KEY, value: engine, updatedById: actor.id },
      update: { value: engine, updatedById: actor.id },
    });
    await audit({ actorId: actor.id, action: 'engine_config_changed', subjectType: 'engine_config', subjectId: ENGINE_CONFIG_KEY, ip: req.ip, meta: { engine } });
    return reply.send({ ok: true, transcription_engine: engine });
  });

  // ── F10: review queue (low-confidence / multi-client / failures) ──────────
  app.get<{ Querystring: { resolved?: string } }>('/admin/review-queue', async (req, reply) => {
    const actor = requireActor(req);
    if (!isAdmin(actor)) return forbidden(reply, 'admin only');
    const resolved = req.query.resolved === 'true';
    const items = await prisma.reviewQueueItem.findMany({
      where: { resolved },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return reply.send({
      ok: true,
      items: items.map((i) => ({
        id: i.id,
        recording_id: i.recordingId,
        reason: i.reason,
        detail: i.detail,
        resolved: i.resolved,
        created_at: i.createdAt,
      })),
    });
  });

  app.post<{ Params: { id: string } }>('/admin/review-queue/:id/resolve', async (req, reply) => {
    const actor = requireActor(req);
    if (!isAdmin(actor)) return forbidden(reply, 'admin only');
    const item = await prisma.reviewQueueItem.update({
      where: { id: Number(req.params.id) },
      data: { resolved: true, resolverId: actor.id, resolvedAt: new Date() },
    });
    await audit({ actorId: actor.id, action: 'review_item_resolved', subjectType: 'review_queue', subjectId: item.id, ip: req.ip });
    return reply.send({ ok: true, id: item.id });
  });
}
