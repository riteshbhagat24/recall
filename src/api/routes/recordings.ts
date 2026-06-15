import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { prisma } from '../../db.js';
import { config, ALLOWED_UPLOAD_EXT, ALLOWED_UPLOAD_MIME } from '../../config.js';
import { audit } from '../../audit.js';
import { storeUpload } from '../../storage.js';
import { enqueueTranscribe } from '../../pipeline/queues.js';
import { requireActor, forbidden } from '../auth.js';
import { canUpload, canAccessClient, isAdmin } from '../../services/permissions.js';
import type { ConsentState } from '@prisma/client';

const PROCESSABLE_CONSENT: ConsentState[] = ['informed', 'explicit'];

export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  // ── F2: file upload capture ──────────────────────────────────────────────
  app.post('/recordings/upload', async (req, reply) => {
    const actor = requireActor(req);
    if (!canUpload(actor)) return forbidden(reply);

    // multipart: collect file + fields
    let fileBuf: Buffer | null = null;
    let filename = 'upload.bin';
    let mimetype = '';
    const fields: Record<string, string> = {};

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename || filename;
        mimetype = part.mimetype || '';
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of part.file) {
          size += chunk.length;
          if (size > config.UPLOAD_MAX_BYTES) {
            return reply.code(413).send({ ok: false, code: 'FILE_TOO_LARGE', message: 'exceeds size cap' });
          }
          chunks.push(chunk);
        }
        fileBuf = Buffer.concat(chunks);
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!fileBuf) {
      return reply.code(400).send({ ok: false, code: 'VALIDATION_FAILED', message: 'file required', field: 'file' });
    }
    const ext = extname(filename).toLowerCase().replace('.', '');
    if (!ALLOWED_UPLOAD_EXT.has(ext) || (mimetype && !ALLOWED_UPLOAD_MIME.has(mimetype))) {
      return reply.code(415).send({ ok: false, code: 'FILE_TYPE_BLOCKED', message: `type .${ext} not allowed` });
    }

    const clientId = Number(fields.client_id);
    const projectId = Number(fields.project_id);
    if (!clientId || !projectId) {
      return reply.code(400).send({ ok: false, code: 'VALIDATION_FAILED', message: 'client_id and project_id required' });
    }
    if (!(await canAccessClient(actor, clientId))) return forbidden(reply, 'no access to client');

    const project = await prisma.project.findFirst({ where: { id: projectId, clientId } });
    if (!project) {
      return reply.code(400).send({ ok: false, code: 'VALIDATION_FAILED', message: 'project not under client' });
    }

    const consentState = (fields.consent_state as ConsentState) ?? 'not_set';
    const stored = await storeUpload(fileBuf, filename);

    // duplicate detection by checksum (PRD edge case 11): warn but allow.
    const dup = await prisma.recording.findFirst({ where: { checksum: stored.checksum } });

    const correlationId = randomUUID();
    const recording = await prisma.recording.create({
      data: {
        clientId,
        projectId,
        source: 'upload',
        storagePath: stored.storagePath,
        title: fields.title || null,
        meetingDate: fields.meeting_date ? new Date(fields.meeting_date) : null,
        checksum: stored.checksum,
        status: 'captured',
        correlationId,
        createdById: actor.id,
        consent: { create: { state: consentState, setById: actor.id } },
      },
    });

    await audit({
      actorId: actor.id,
      action: 'recording_captured',
      subjectType: 'recording',
      subjectId: recording.id,
      ip: req.ip,
      meta: { source: 'upload', duplicate: Boolean(dup) },
    });

    // F9: only enqueue if consent permits processing.
    let queued: string | null = null;
    if (PROCESSABLE_CONSENT.includes(consentState)) {
      await enqueueTranscribe({ recordingId: recording.id, correlationId });
      queued = 'transcription';
    }

    return reply.send({
      ok: true,
      recording_id: recording.id,
      status: recording.status,
      queued,
      duplicate_of: dup?.id ?? null,
    });
  });

  // ── F1 (Phase-2-ready stub): Meet bot capture ────────────────────────────
  app.post('/recordings/meet', async (req, reply) => {
    const actor = requireActor(req);
    if (!canUpload(actor)) return forbidden(reply);
    // The Meet bot is an enhancement, not a blocker (REQ-14.1) — file upload is
    // the always-available path. This endpoint is reserved; capture infra is
    // sequenced after the spine + benchmark gate.
    return reply.code(501).send({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Meet bot capture not enabled in this build; use /recordings/upload',
    });
  });

  // ── Pipeline status (REQ-6.1) ─────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/recordings/:id/status', async (req, reply) => {
    const actor = requireActor(req);
    const recording = await prisma.recording.findUnique({
      where: { id: Number(req.params.id) },
      include: { consent: true, conversation: { select: { id: true } } },
    });
    if (!recording) return reply.code(404).send({ ok: false, code: 'VALIDATION_FAILED', message: 'not found' });
    if (!(await canAccessClient(actor, recording.clientId))) return forbidden(reply);

    return reply.send({
      ok: true,
      recording_id: recording.id,
      status: recording.status,
      failure_reason: recording.failureReason,
      consent: recording.consent?.state ?? 'not_set',
      conversation_id: recording.conversation?.id ?? null,
      correlation_id: recording.correlationId,
    });
  });

  // ── Set consent (US-11, F9) ───────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { state: ConsentState; note?: string } }>(
    '/recordings/:id/consent',
    async (req, reply) => {
      const actor = requireActor(req);
      if (!canUpload(actor)) return forbidden(reply);
      const recording = await prisma.recording.findUnique({
        where: { id: Number(req.params.id) },
        include: { consent: true },
      });
      if (!recording) return reply.code(404).send({ ok: false, code: 'VALIDATION_FAILED', message: 'not found' });
      if (!(await canAccessClient(actor, recording.clientId))) return forbidden(reply);

      const state = req.body.state;
      await prisma.consentRecord.upsert({
        where: { recordingId: recording.id },
        create: { recordingId: recording.id, state, setById: actor.id, note: req.body.note ?? null },
        update: { state, setById: actor.id, note: req.body.note ?? null },
      });
      await audit({
        actorId: actor.id,
        action: 'consent_set',
        subjectType: 'recording',
        subjectId: recording.id,
        ip: req.ip,
        meta: { state },
      });

      // If consent now permits and we haven't started, kick off the pipeline.
      let queued: string | null = null;
      if (PROCESSABLE_CONSENT.includes(state) && recording.status === 'captured') {
        await enqueueTranscribe({ recordingId: recording.id, correlationId: recording.correlationId });
        queued = 'transcription';
      }
      return reply.send({ ok: true, recording_id: recording.id, consent: state, queued });
    },
  );

  // ── Retry a failed stage (admin) ──────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/recordings/:id/retry', async (req, reply) => {
    const actor = requireActor(req);
    if (!isAdmin(actor)) return forbidden(reply, 'admin only');
    const recording = await prisma.recording.findUnique({ where: { id: Number(req.params.id) } });
    if (!recording) return reply.code(404).send({ ok: false, code: 'VALIDATION_FAILED', message: 'not found' });

    await prisma.recording.update({
      where: { id: recording.id },
      data: { status: 'captured', failureReason: null },
    });
    await enqueueTranscribe({ recordingId: recording.id, correlationId: recording.correlationId });
    await audit({ actorId: actor.id, action: 'recording_retried', subjectType: 'recording', subjectId: recording.id, ip: req.ip });
    return reply.send({ ok: true, recording_id: recording.id, queued: 'transcription' });
  });
}
