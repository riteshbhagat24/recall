import { getBoss, QUEUE, stopBoss } from '../pipeline/queues.js';
import type {
  TranscribeJobData,
  StructureJobData,
  SummaryRefreshJobData,
} from '../pipeline/queues.js';
import { runTranscribeJob } from './transcribeJob.js';
import { runStructureJob } from './structureJob.js';
import { runSummaryRefreshJob } from './summaryJob.js';
import { beat } from './heartbeat.js';
import { logger } from '../logger.js';
import { ensureStorage } from '../storage.js';
import { disconnect } from '../db.js';

/**
 * The VPS worker (PRD §8 stages 2–4). Supervisor keeps this alive; it processes
 * the queue continuously with retries/backoff and writes a heartbeat each tick.
 */
async function main() {
  await ensureStorage();
  const boss = await getBoss();

  await boss.work<TranscribeJobData>(QUEUE.transcribe, async ([job]) => {
    if (job) await runTranscribeJob(job.data);
  });
  await boss.work<StructureJobData>(QUEUE.structure, async ([job]) => {
    if (job) await runStructureJob(job.data);
  });
  await boss.work<SummaryRefreshJobData>(QUEUE.summaryRefresh, async ([job]) => {
    if (job) await runSummaryRefreshJob(job.data);
  });

  // Heartbeat tick (REQ-16.1). Independent of job flow so /health detects a
  // wedged worker even when the queue is idle.
  await beat();
  const hb = setInterval(() => {
    beat().catch((err) => logger.error({ err }, 'heartbeat write failed'));
  }, 30_000);

  logger.info('worker started; queues registered: transcribe, structure, summary-refresh');

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'worker shutting down');
    clearInterval(hb);
    await stopBoss();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker crashed on startup');
  process.exit(1);
});
