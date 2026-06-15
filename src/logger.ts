import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined, // omit pid/hostname noise
});

/** Child logger that carries a recording's correlation id through the pipeline. */
export function pipelineLogger(correlationId: string, recordingId: number) {
  return logger.child({ correlationId, recordingId });
}
