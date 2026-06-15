import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { audit } from '../../audit.js';
import { requireActor, forbidden } from '../auth.js';
import { canAccessClient, canEditOutputs, isFinancialBlocked } from '../../services/permissions.js';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // ── F7: per-call auto-outputs (transcript + structured) ───────────────────
  app.get<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
    const actor = requireActor(req);
    const conversation = await prisma.conversation.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        actionItems: true,
        decisions: true,
        recording: { include: { transcript: { include: { turns: { orderBy: { id: 'asc' } } } } } },
      },
    });
    if (!conversation) return reply.code(404).send({ ok: false, code: 'VALIDATION_FAILED', message: 'not found' });
    if (!(await canAccessClient(actor, conversation.clientId))) return forbidden(reply);

    // Segment-level Financial/Legal enforcement (REQ-12.2): Design & Video never
    // receive financial turns, even inside an otherwise-visible call. Filtered
    // server-side; we do not signal that turns were hidden.
    const blocked = isFinancialBlocked(actor);
    const visibleActionItems = conversation.actionItems.filter((a) => !(blocked && a.isFinancialLegal));
    const visibleDecisions = conversation.decisions.filter((d) => !(blocked && d.isFinancialLegal));
    const turns = (conversation.recording.transcript?.turns ?? [])
      .filter((t) => !(blocked && t.isFinancialLegal))
      .map((t) => ({
        speaker_label: t.speakerLabel,
        start_ts: t.startTs,
        end_ts: t.endTs,
        text: t.text,
        detected_lang: t.detectedLang,
      }));

    await audit({
      actorId: actor.id,
      action: 'conversation_viewed',
      subjectType: 'conversation',
      subjectId: conversation.id,
      ip: req.ip,
    });

    return reply.send({
      ok: true,
      conversation: {
        id: conversation.id,
        client_id: conversation.clientId,
        project_id: conversation.projectId,
        title: conversation.title,
        topic_tag: conversation.topicTag,
        summary: conversation.summary,
        tag_confidence: conversation.tagConfidence,
        needs_review: conversation.needsReview,
        action_items: visibleActionItems.map((a) => ({
          id: a.id,
          text: a.text,
          owner_label: a.ownerLabel,
          due_text: a.dueText,
          status: a.status,
        })),
        decisions: visibleDecisions.map((d) => ({ id: d.id, text: d.text })),
        transcript: turns,
      },
    });
  });

  // ── PUT outputs: correct summary/actions/decisions (edit roles) ───────────
  app.put<{
    Params: { id: string };
    Body: {
      summary?: string;
      action_items?: { text: string; owner_label?: string; due_text?: string }[];
      decisions?: { text: string }[];
    };
  }>('/conversations/:id/outputs', async (req, reply) => {
    const actor = requireActor(req);
    if (!canEditOutputs(actor)) return forbidden(reply, 'edit role required');
    const conversation = await prisma.conversation.findUnique({ where: { id: Number(req.params.id) } });
    if (!conversation) return reply.code(404).send({ ok: false, code: 'VALIDATION_FAILED', message: 'not found' });
    if (!(await canAccessClient(actor, conversation.clientId))) return forbidden(reply);

    // capture prior state for the audit trail (edits are versioned + logged, F7)
    const before = await prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: { actionItems: true, decisions: true },
    });

    await prisma.$transaction(async (tx) => {
      if (req.body.summary != null) {
        await tx.conversation.update({ where: { id: conversation.id }, data: { summary: req.body.summary } });
      }
      if (req.body.action_items) {
        await tx.actionItem.deleteMany({ where: { conversationId: conversation.id } });
        await tx.actionItem.createMany({
          data: req.body.action_items.map((a) => ({
            conversationId: conversation.id,
            text: a.text,
            ownerLabel: a.owner_label ?? null,
            dueText: a.due_text ?? null,
          })),
        });
      }
      if (req.body.decisions) {
        await tx.decision.deleteMany({ where: { conversationId: conversation.id } });
        await tx.decision.createMany({
          data: req.body.decisions.map((d) => ({ conversationId: conversation.id, text: d.text })),
        });
      }
    });

    await audit({
      actorId: actor.id,
      action: 'conversation_outputs_edited',
      subjectType: 'conversation',
      subjectId: conversation.id,
      ip: req.ip,
      meta: { before: { summary: before?.summary, actionItems: before?.actionItems.length, decisions: before?.decisions.length } },
    });

    return reply.send({ ok: true, conversation_id: conversation.id });
  });
}
