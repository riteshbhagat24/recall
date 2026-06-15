import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { audit } from '../../audit.js';
import { requireActor, forbidden } from '../auth.js';
import type { WorkspaceItemType } from '@prisma/client';

/**
 * Private workspace (PRD F-MEM, REQ-4.7 / REQ-5.7 / REQ-12.3).
 *
 * HARD GUARANTEE enforced here at the data-access layer (not UI): every handler
 * touches ONLY user_workspaces / workspace_items, scoped to the caller's own
 * user id. There is NO code path that writes a workspace item into shared
 * tables (transcripts, conversations, summaries) — that path does not exist by
 * design. Reads of shared memory go through the normal permission-filtered
 * endpoints; what lands here are copies/notes/refs the user chose to keep.
 */

async function ownWorkspace(userId: number) {
  const existing = await prisma.userWorkspace.findFirst({ where: { userId } });
  if (existing) return existing;
  return prisma.userWorkspace.create({ data: { userId, name: 'My workspace' } });
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // List the caller's own workspace + items (self only).
  app.get('/workspace', async (req, reply) => {
    const actor = requireActor(req);
    const ws = await ownWorkspace(actor.id);
    const items = await prisma.workspaceItem.findMany({
      where: { workspaceId: ws.id },
      orderBy: { updatedAt: 'desc' },
    });
    return reply.send({
      ok: true,
      workspace: { id: ws.id, name: ws.name },
      items: items.map(serialize),
    });
  });

  // Create a private item. `refs` are IDs READ from shared memory; storing them
  // here never mutates shared state.
  app.post<{ Body: { type: WorkspaceItemType; content: string; refs?: unknown } }>(
    '/workspace/items',
    async (req, reply) => {
      const actor = requireActor(req);
      const ws = await ownWorkspace(actor.id);
      const { type, content } = req.body;
      if (!type || content == null) {
        return reply.code(400).send({ ok: false, code: 'VALIDATION_FAILED', message: 'type and content required' });
      }
      const item = await prisma.workspaceItem.create({
        data: {
          workspaceId: ws.id,
          type,
          content,
          refsJson: (req.body.refs ?? undefined) as object | undefined,
        },
      });
      await audit({ actorId: actor.id, action: 'workspace_item_created', subjectType: 'workspace_item', subjectId: item.id, ip: req.ip });
      return reply.send({ ok: true, item: serialize(item) });
    },
  );

  // Update an item — only if it belongs to the caller's own workspace.
  app.put<{ Params: { id: string }; Body: { content?: string; refs?: unknown } }>(
    '/workspace/items/:id',
    async (req, reply) => {
      const actor = requireActor(req);
      const ws = await ownWorkspace(actor.id);
      const item = await prisma.workspaceItem.findUnique({ where: { id: Number(req.params.id) } });
      if (!item || item.workspaceId !== ws.id) {
        // isolation: never reveal another user's item exists
        return forbidden(reply, 'not your workspace item');
      }
      const updated = await prisma.workspaceItem.update({
        where: { id: item.id },
        data: {
          content: req.body.content ?? item.content,
          refsJson: (req.body.refs ?? item.refsJson ?? undefined) as object | undefined,
        },
      });
      return reply.send({ ok: true, item: serialize(updated) });
    },
  );

  app.delete<{ Params: { id: string } }>('/workspace/items/:id', async (req, reply) => {
    const actor = requireActor(req);
    const ws = await ownWorkspace(actor.id);
    const item = await prisma.workspaceItem.findUnique({ where: { id: Number(req.params.id) } });
    if (!item || item.workspaceId !== ws.id) return forbidden(reply, 'not your workspace item');
    await prisma.workspaceItem.delete({ where: { id: item.id } });
    return reply.send({ ok: true });
  });
}

function serialize(item: {
  id: number;
  type: WorkspaceItemType;
  content: string;
  refsJson: unknown;
  updatedAt: Date;
}) {
  return { id: item.id, type: item.type, content: item.content, refs: item.refsJson ?? null, updated_at: item.updatedAt };
}
