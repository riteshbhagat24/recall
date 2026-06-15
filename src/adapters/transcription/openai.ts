import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from '../../config.js';
import { fetchWithTimeout } from './http.js';
import {
  TranscriptionEngineError,
  type AudioRef,
  type TranscribeOptions,
  type TranscriptionDriver,
  type TranscriptResult,
  type TranscriptTurnResult,
} from './types.js';

/**
 * OpenAIDriver — benchmark comparison engine (gpt-4o-transcribe) per PRD §13.1.
 *
 * Caveat captured here so it isn't a surprise: the gpt-4o-transcribe endpoint
 * does NOT return speaker diarization or word timestamps. We therefore produce a
 * single-speaker transcript with best-effort sentence segmentation. Diarization
 * is a real differentiator for Sarvam — which is exactly why the benchmark gate
 * (PRD §US-3) compares them on real calls before committing.
 */
export class OpenAIDriver implements TranscriptionDriver {
  readonly name = 'openai';

  async transcribe(audio: AudioRef, opts: TranscribeOptions): Promise<TranscriptResult> {
    if (!config.OPENAI_API_KEY) {
      throw new TranscriptionEngineError('OPENAI_API_KEY is not set', this.name);
    }

    const bytes = await readFile(audio.storagePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), basename(audio.storagePath));
    form.append('model', 'gpt-4o-transcribe');
    form.append('response_format', 'json');
    // Omit `language` for 'auto' so code-mixed audio is auto-detected (PRD §13.2).
    if (opts.languageHint !== 'auto') form.append('language', opts.languageHint);

    const res = await fetchWithTimeout(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
        body: form,
      },
      opts.timeoutMs,
      this.name,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TranscriptionEngineError(
        `openai returned ${res.status}: ${body.slice(0, 500)}`,
        this.name,
      );
    }

    const data = (await res.json()) as { text?: string };
    const text = (data.text ?? '').trim();

    // No diarization/timestamps from this endpoint — one synthetic speaker turn.
    const turns: TranscriptTurnResult[] = [
      { speakerLabel: 'Speaker 1', startTs: 0, endTs: audio.durationSec ?? 0, text },
    ];

    return {
      fullText: text,
      turns,
      engineUsed: 'openai',
      languageSummary: 'auto-detected (gpt-4o-transcribe, no diarization)',
    };
  }
}
