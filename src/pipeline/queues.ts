import PgBoss from 'pg-boss';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Queue backbone (PRD §8). Each pipeline stage is decoupled by a queue so a
 * failure in one stage never blocks others and any stage retries independently.
 * pg-boss rides on the SAME Postgres as everything else — no Redis to operate.
 */
export const QUEUE = {
  transcribe: 'transcribe',
  structure: 'structure',
  summaryRefresh: 'summary-refresh',
} as const;

export interface TranscribeJobData {
  recordingId: number;
  correlationId: string;
}
export interface StructureJobData {
  recordingId: number;
  correlationId: string;
}
export interface SummaryRefreshJobData {
  clientId: number;
  projectId: number;
  correlationId: string;
}

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const b = new PgBoss({
    connectionString: config.DATABASE_URL,
    // generous retry policy with backoff — matches the PRD's "max 3" transcription
    // retries; per-queue overrides are set when sending.
    retryLimit: 3,
    retryBackoff: true,
  });
  b.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await b.start();
  for (const name of Object.values(QUEUE)) {
    await b.createQueue(name);
  }
  boss = b;
  return b;
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true });
    boss = null;
  }
}

// ── Enqueue helpers (used by capture + each stage to hand off to the next) ──
export async function enqueueTranscribe(data: TranscribeJobData): Promise<void> {
  const b = await getBoss();
  await b.send(QUEUE.transcribe, data, { retryLimit: 3, retryBackoff: true });
}
export async function enqueueStructure(data: StructureJobData): Promise<void> {
  const b = await getBoss();
  await b.send(QUEUE.structure, data, { retryLimit: 1 }); // F4: retry once → review
}
export async function enqueueSummaryRefresh(data: SummaryRefreshJobData): Promise<void> {
  const b = await getBoss();
  await b.send(QUEUE.summaryRefresh, data, { retryLimit: 3, retryBackoff: true });
}
