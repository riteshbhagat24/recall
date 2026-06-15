import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { audit } from '../../audit.js';
import { requireActor, forbidden } from '../auth.js';
import { canAccessClient, isFinancialBlocked } from '../../services/permissions.js';
import { redactFinancialProse } from '../../services/financial.js';
import { buildContextPack } from '../../services/contextPack.js';

export async function kbRoutes(app: FastifyInstance): Promise<void> {
  // ── US-8 / F-MEM L2: living client summary ────────────────────────────────
  app.get<{ Params: { id: string } }>('/clients/:id/summary', async (req, reply) => {
    const actor = requireActor(req);
    const clientId = Number(req.params.id);
    if (!(await canAccessClient(actor, clientId))) return forbidden(reply);

    const summary = await prisma.entitySummary.findFirst({
      where: { entityType: 'client', entityId: clientId },
      orderBy: { version: 'desc' },
    });
    if (!summary) {
      return reply.send({ ok: true, client_id: clientId, summary: null, version: 0 });
    }
    return reply.send({
      ok: true,
      client_id: clientId,
      summary: isFinancialBlocked(actor) ? redactFinancialProse(summary.summary) : summary.summary,
      version: summary.version,
      generated_at: summary.generatedAt,
    });
  });

  // ── F8: context-pack export ───────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { client?: string; q?: string } }>(
    '/projects/:id/context-pack',
    async (req, reply) => {
      const actor = requireActor(req);
      const projectId = Number(req.params.id);
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) return reply.code(404).send({ ok: false, code: 'VALIDATION_FAILED', message: 'not found' });
      if (!(await canAccessClient(actor, project.clientId))) return forbidden(reply);

      const markdown = await buildContextPack(actor, {
        clientId: project.clientId,
        projectId,
        query: req.query.q,
      });

      await audit({
        actorId: actor.id,
        action: 'context_pack_exported',
        subjectType: 'project',
        subjectId: projectId,
        ip: req.ip,
      });

      return reply.send({ ok: true, project_id: projectId, format: 'markdown', content: markdown });
    },
  );
}
