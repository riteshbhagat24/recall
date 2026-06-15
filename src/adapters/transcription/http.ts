import { TranscriptionEngineError } from './types.js';

/** fetch with an abort-based timeout, normalized into a TranscriptionEngineError. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  engine: string,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TranscriptionEngineError(
        `engine '${engine}' timed out after ${timeoutMs}ms`,
        engine,
        'timeout',
      );
    }
    throw new TranscriptionEngineError(
      `engine '${engine}' request failed: ${(err as Error).message}`,
      engine,
      'engine',
    );
  } finally {
    clearTimeout(timer);
  }
}
