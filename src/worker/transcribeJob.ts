import { prisma } from '../db.js';
import { pipelineLogger } from '../logger.js';
import { config } from '../config.js';
import { audit } from '../audit.js';
import {
  getTranscriptionDriver,
  DEFAULT_TRANSCRIBE_OPTIONS,
  TranscriptionEngineError,
} from '../adapters/transcription/index.js';
import { fileSize } from '../storage.js';
import { enqueueStructure, type TranscribeJobData } from '../pipeline/queues.js';

/**
 * Stage 2 — Transcribe (PRD §8). Pulls the configured engine THROUGH the
 * adapter, normalizes into the common TranscriptResult, stores transcript +
 * turns, then enqueues StructureJob. Vendor-agnostic: this code never names
 * Sarvam/OpenAI.
 */
export async function runTranscribeJob(data: TranscribeJobData): Promise<void> {
  const log = pipelineLogger(data.correlationId, data.recordingId);
  const recording = await prisma.recording.findUnique({ where: { id: data.recordingId } });
  if (!recording) {
    log.warn('recording vanished before transcription');
    return;
  }

  // Guard: too-short calls are skipped (PRD F1/F3).
  if (recording.durationSec != null && recording.durationSec < config.MIN_AUDIO_SECONDS) {
    await fail(data.recordingId, `call too short (<${config.MIN_AUDIO_SECONDS}s)`);
    log.warn('skipping: call too short');
    return;
  }

  await prisma.recording.update({
    where: { id: data.recordingId },
    data: { status: 'transcribing' },
  });

  const durationSec =
    recording.durationSec ?? Math.round((await safeSize(recording.storagePath)) / 16000);
  const timeoutMs = Math.max(
    60_000,
    Math.round((durationSec / 3600) * config.TRANSCRIBE_TIMEOUT_MS_PER_HOUR),
  );

  try {
    const driver = await getTranscriptionDriver();
    const result = await driver.transcribe(
      { storagePath: recording.storagePath, durationSec: recording.durationSec ?? undefined },
      {
        ...DEFAULT_TRANSCRIBE_OPTIONS,
        timeoutMs,
        chunkSeconds: config.TRANSCRIBE_CHUNK_SECONDS,
      },
    );

    const wordCount = result.fullText.split(/\s+/).filter(Boolean).length;
    await prisma.$transaction(async (tx) => {
      const transcript = await tx.transcript.create({
        data: {
          recordingId: recording.id,
          engineUsed: result.engineUsed,
          languageSummary: result.languageSummary,
          fullText: result.fullText,
          wordCount,
        },
      });
      if (result.turns.length > 0) {
        await tx.transcriptTurn.createMany({
          data: result.turns.map((t) => ({
            transcriptId: transcript.id,
            speakerLabel: t.speakerLabel,
            startTs: t.startTs,
            endTs: t.endTs,
            text: t.text,
            detectedLang: t.detectedLang ?? null,
          })),
        });
      }
      await tx.recording.update({
        where: { id: recording.id },
        data: { status: 'transcribed' },
      });
    });

    await audit({
      action: 'transcription_completed',
      subjectType: 'recording',
      subjectId: recording.id,
      meta: { engine: result.engineUsed, wordCount, durationSec },
    });
    await enqueueStructure({ recordingId: recording.id, correlationId: data.correlationId });
    log.info({ engine: result.engineUsed, wordCount }, 'transcribed');
  } catch (err) {
    const reason =
      err instanceof TranscriptionEngineError
        ? `${err.kind}: ${err.message}`
        : (err as Error).message;
    // Let pg-boss retries (max 3, backoff) re-run before we give up. On the
    // final attempt the job throws; mark failed so the UI surfaces it.
    await fail(data.recordingId, reason);
    log.error({ err }, 'transcription failed');
    throw err; // surface to pg-boss for retry/backoff
  }
}

async function fail(recordingId: number, reason: string): Promise<void> {
  await prisma.recording.update({
    where: { id: recordingId },
    data: { status: 'transcription_failed', failureReason: reason.slice(0, 500) },
  });
}

async function safeSize(path: string): Promise<number> {
  try {
    return await fileSize(path);
  } catch {
    return 0;
  }
}
