import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit.js';
import { requireActor } from '../auth.js';
import { hybridSearch } from '../../services/search.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // ── F6: hybrid search (permission-filtered server-side) ───────────────────
  app.get<{
    Querystring: { q?: string; client?: string; project?: string; speaker?: string; limit?: string };
  }>('/search', async (req, reply) => {
    const actor = requireActor(req);
    const q = (req.query.q ?? '').trim();
    if (!q) return reply.code(400).send({ ok: false, code: 'VALIDATION_FAILED', message: 'q required', field: 'q' });

    const results = await hybridSearch(
      actor,
      q,
      {
        client: req.query.client ? Number(req.query.client) : undefined,
        project: req.query.project ? Number(req.query.project) : undefined,
        speaker: req.query.speaker,
      },
      req.query.limit ? Math.min(100, Number(req.query.limit)) : 20,
    );

    await audit({
      actorId: actor.id,
      action: 'search_performed',
      subjectType: 'search',
      subjectId: null,
      ip: req.ip,
      meta: { q, count: results.length },
    });

    return reply.send({
      ok: true,
      results: results.map((r) => ({
        conversation_id: r.conversationId,
        client_id: r.clientId,
        project_id: r.projectId,
        snippet: r.snippet,
        speaker_label: r.speakerLabel,
        timestamp: r.timestamp,
        score: Number(r.score.toFixed(4)),
      })),
    });
  });
}
