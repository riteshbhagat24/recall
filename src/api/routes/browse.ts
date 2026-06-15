import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { requireActor } from '../auth.js';
import { visibleClientIds } from '../../services/permissions.js';

/**
 * Read/list endpoints backing the §6 "Client → Project → Conversation browser"
 * and the recordings pipeline-status view. All permission-scoped server-side.
 */
export async function browseRoutes(app: FastifyInstance): Promise<void> {
  // Clients (+ projects) the actor may see. Performance team is client-scoped.
  app.get('/clients', async (req, reply) => {
    const actor = requireActor(req);
    const allowed = await visibleClientIds(actor);
    const clients = await prisma.client.findMany({
      where: allowed === null ? {} : { id: { in: allowed.length ? allowed : [-1] } },
      include: { projects: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    return reply.send({ ok: true, clients });
  });

  // Recordings with live pipeline status (REQ-6.1).
  app.get('/recordings', async (req, reply) => {
    const actor = requireActor(req);
    const allowed = await visibleClientIds(actor);
    const recordings = await prisma.recording.findMany({
      where: allowed === null ? {} : { clientId: { in: allowed.length ? allowed : [-1] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        client: { select: { name: true } },
        project: { select: { name: true } },
        consent: { select: { state: true } },
        conversation: { select: { id: true } },
      },
    });
    return reply.send({
      ok: true,
      recordings: recordings.map((r) => ({
        id: r.id,
        title: r.title,
        client: r.client.name,
        project: r.project.name,
        status: r.status,
        failure_reason: r.failureReason,
        consent: r.consent?.state ?? 'not_set',
        conversation_id: r.conversation?.id ?? null,
        created_at: r.createdAt,
      })),
    });
  });

  // Conversations (KB), optionally filtered by client/project.
  app.get<{ Querystring: { client?: string; project?: string } }>(
    '/conversations',
    async (req, reply) => {
      const actor = requireActor(req);
      const allowed = await visibleClientIds(actor);
      const where: Record<string, unknown> = {};
      if (allowed !== null) where.clientId = { in: allowed.length ? allowed : [-1] };
      if (req.query.client) where.clientId = Number(req.query.client);
      if (req.query.project) where.projectId = Number(req.query.project);
      const conversations = await prisma.conversation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { client: { select: { name: true } }, project: { select: { name: true } } },
      });
      return reply.send({
        ok: true,
        conversations: conversations.map((c) => ({
          id: c.id,
          title: c.title,
          topic_tag: c.topicTag,
          client: c.client.name,
          project: c.project.name,
          needs_review: c.needsReview,
          created_at: c.createdAt,
        })),
      });
    },
  );
}

/**
 * Public (no-auth) dev convenience: the 7 seeded users, so the dashboard's
 * role-switcher can populate before a role is chosen. Mirrors the x-user-id shim.
 */
export async function devUsersRoute(app: FastifyInstance): Promise<void> {
  app.get('/dev/users', async (_req, reply) => {
    const users = await prisma.user.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, role: true },
    });
    return reply.send({ ok: true, users });
  });
}
