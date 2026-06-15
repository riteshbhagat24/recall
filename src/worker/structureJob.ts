import { prisma } from '../db.js';
import { pipelineLogger } from '../logger.js';
import { audit } from '../audit.js';
import { structureTranscript } from '../services/structuring.js';
import { getEmbeddingProvider } from '../services/embeddings.js';
import { isFinancialText } from '../services/financial.js';
import { insertEmbeddings } from '../services/vectorStore.js';
import { enqueueSummaryRefresh, type StructureJobData } from '../pipeline/queues.js';
import type { TranscriptTurnResult } from '../adapters/transcription/types.js';

/**
 * Stage 3 — Structure (PRD §8, F4). Sends transcript text to Claude, writes
 * summary/actions/decisions, applies SEGMENT-LEVEL financial/legal tagging,
 * computes per-passage embeddings into pgvector, files the result as a
 * conversation under Client → Project, then enqueues SummaryRefreshJob.
 *
 * On structuring failure (parse/refusal) after the one retry, the recording is
 * marked structure_failed and queued for manual review — but the transcript is
 * already stored and keyword-searchable (PRD edge case 5).
 */
export async function runStructureJob(data: StructureJobData): Promise<void> {
  const log = pipelineLogger(data.correlationId, data.recordingId);
  const recording = await prisma.recording.findUnique({
    where: { id: data.recordingId },
    include: {
      client: true,
      project: true,
      transcript: { include: { turns: { orderBy: { id: 'asc' } } } },
    },
  });
  if (!recording || !recording.transcript) {
    log.warn('recording/transcript missing before structuring');
    return;
  }

  await prisma.recording.update({
    where: { id: recording.id },
    data: { status: 'structuring' },
  });

  const turns = recording.transcript.turns;
  const turnResults: TranscriptTurnResult[] = turns.map((t) => ({
    speakerLabel: t.speakerLabel,
    startTs: t.startTs,
    endTs: t.endTs,
    text: t.text,
    detectedLang: t.detectedLang ?? undefined,
  }));

  let structured;
  try {
    structured = await structureTranscript(turnResults, {
      clientName: recording.client.name,
      projectName: recording.project.name,
    });
  } catch (err) {
    await prisma.recording.update({
      where: { id: recording.id },
      data: { status: 'structure_failed', failureReason: (err as Error).message.slice(0, 500) },
    });
    await prisma.reviewQueueItem.create({
      data: {
        recordingId: recording.id,
        reason: 'parse_failure',
        detail: (err as Error).message.slice(0, 500),
      },
    });
    await audit({
      action: 'structuring_failed',
      subjectType: 'recording',
      subjectId: recording.id,
      meta: { error: (err as Error).message },
    });
    log.error({ err }, 'structuring failed → review queue');
    throw err; // let pg-boss record the failure
  }

  // Segment-level financial/legal tagging on the turns themselves.
  const finIdx = new Set(structured.financialLegalTurnIndices.filter((i) => i >= 0 && i < turns.length));
  await Promise.all(
    turns.map((t, i) =>
      finIdx.has(i)
        ? prisma.transcriptTurn.update({ where: { id: t.id }, data: { isFinancialLegal: true } })
        : Promise.resolve(),
    ),
  );

  // Low-confidence or multi-client → file but flag for review (PRD US-6, F4).
  const needsReview = structured.tagConfidence === 'low' || structured.multiClient;

  const conversation = await prisma.conversation.create({
    data: {
      clientId: recording.clientId,
      projectId: recording.projectId,
      recordingId: recording.id,
      title: recording.title ?? `${recording.client.name} — ${structured.topicTag}`,
      topicTag: structured.topicTag,
      summary: structured.summary,
      tagConfidence: structured.tagConfidence,
      needsReview,
      actionItems: {
        create: structured.actionItems.map((a) => ({
          text: a.text,
          ownerLabel: a.ownerLabel || null,
          dueText: a.dueText || null,
          isFinancialLegal: isFinancialText(a.text),
        })),
      },
      decisions: {
        create: structured.decisions.map((d) => ({
          text: d.text,
          isFinancialLegal: isFinancialText(d.text),
        })),
      },
    },
  });

  if (needsReview) {
    await prisma.reviewQueueItem.create({
      data: {
        recordingId: recording.id,
        reason: structured.multiClient ? 'multi_client' : 'low_tag_confidence',
        detail: `topic=${structured.topicTag}`,
      },
    });
  }

  // Per-passage embeddings (one per turn). Failure is non-fatal: keyword search
  // still works without vectors (PRD edge case 13). Use the freshly-computed
  // financial flags (finIdx), not the stale in-memory rows.
  try {
    await embedTurns(
      conversation.id,
      turns.map((t, i) => ({ id: t.id, text: t.text, isFinancialLegal: finIdx.has(i) })),
    );
  } catch (err) {
    log.warn({ err }, 'embedding failed — keyword search still available');
  }

  await prisma.recording.update({ where: { id: recording.id }, data: { status: 'ready' } });
  await audit({
    action: 'structuring_completed',
    subjectType: 'conversation',
    subjectId: conversation.id,
    meta: { needsReview, financialSegments: finIdx.size },
  });
  await enqueueSummaryRefresh({
    clientId: recording.clientId,
    projectId: recording.projectId,
    correlationId: data.correlationId,
  });
  log.info({ conversationId: conversation.id, needsReview }, 'structured → ready');
}

async function embedTurns(
  conversationId: number,
  turns: { id: number; text: string; isFinancialLegal: boolean }[],
): Promise<void> {
  const provider = getEmbeddingProvider();
  const texts = turns.map((t) => t.text);
  const vectors = await provider.embed(texts);
  await insertEmbeddings(
    turns.map((t, i) => ({
      conversationId,
      turnId: t.id,
      passageText: t.text,
      vector: vectors[i]!,
      modelUsed: provider.model,
      isFinancialLegal: t.isFinancialLegal,
    })),
  );
}
