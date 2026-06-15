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
 * SarvamDriver — launch engine, purpose-built for Indic + code-mixed (Hinglish)
 * speech (PRD §13.1). Uses Sarvam's speech-to-text-translate / diarization
 * endpoint and normalizes the response into the common TranscriptResult.
 *
 * IMPORTANT: languageHint='auto' maps to Sarvam's multilingual mode. We never
 * force a single language — forcing "hi" or "en" is what produces gibberish on
 * intra-sentence switches (PRD §13.2). Endpoint shapes evolve; the normalization
 * below is defensive about field names so a minor API change doesn't break the
 * contract for everything downstream.
 */
export class SarvamDriver implements TranscriptionDriver {
  readonly name = 'sarvam';

  async transcribe(audio: AudioRef, opts: TranscribeOptions): Promise<TranscriptResult> {
    if (!config.SARVAM_API_KEY) {
      throw new TranscriptionEngineError('SARVAM_API_KEY is not set', this.name);
    }

    const bytes = await readFile(audio.storagePath);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)]),
      basename(audio.storagePath),
    );
    // 'unknown'/auto lets Sarvam auto-detect and handle code-mixing.
    form.append('language_code', opts.languageHint === 'auto' ? 'unknown' : opts.languageHint);
    form.append('model', 'saarika:v2');
    form.append('with_diarization', String(opts.diarize));
    form.append('with_timestamps', 'true');

    const res = await fetchWithTimeout(
      `${config.SARVAM_BASE_URL.replace(/\/$/, '')}/speech-to-text`,
      {
        method: 'POST',
        headers: { 'api-subscription-key': config.SARVAM_API_KEY },
        body: form,
      },
      opts.timeoutMs,
      this.name,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TranscriptionEngineError(
        `sarvam returned ${res.status}: ${body.slice(0, 500)}`,
        this.name,
      );
    }

    const data = (await res.json()) as SarvamResponse;
    return normalizeSarvam(data);
  }
}

// ── Sarvam response shape (defensive — fields vary across model versions) ──
interface SarvamWord {
  word?: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  speaker_id?: string | number;
}
interface SarvamDiarEntry {
  transcript?: string;
  text?: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  speaker_id?: string | number;
  language_code?: string;
}
interface SarvamResponse {
  transcript?: string;
  language_code?: string;
  diarized_transcript?: { entries?: SarvamDiarEntry[] } | SarvamDiarEntry[];
  timestamps?: { words?: SarvamWord[] };
}

function normalizeSarvam(data: SarvamResponse): TranscriptResult {
  const entries = Array.isArray(data.diarized_transcript)
    ? data.diarized_transcript
    : (data.diarized_transcript?.entries ?? []);

  let turns: TranscriptTurnResult[];
  if (entries.length > 0) {
    turns = entries.map((e) => ({
      speakerLabel: speakerLabel(e.speaker_id),
      startTs: e.start_time_seconds ?? 0,
      endTs: e.end_time_seconds ?? 0,
      text: (e.transcript ?? e.text ?? '').trim(),
      detectedLang: e.language_code,
    }));
  } else {
    // No diarization payload — fall back to one turn with the flat transcript.
    turns = [
      {
        speakerLabel: 'Speaker 1',
        startTs: 0,
        endTs: 0,
        text: (data.transcript ?? '').trim(),
        detectedLang: data.language_code,
      },
    ];
  }

  const fullText = turns.map((t) => `${t.speakerLabel}: ${t.text}`).join('\n');
  return {
    fullText,
    turns: turns.filter((t) => t.text.length > 0),
    engineUsed: 'sarvam',
    languageSummary: data.language_code ?? 'multilingual (auto)',
  };
}

function speakerLabel(id: string | number | undefined): string {
  if (id == null) return 'Speaker 1';
  // Normalize "SPEAKER_00" / 0 → "Speaker 1"
  const n = typeof id === 'number' ? id : parseInt(String(id).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? `Speaker ${n + 1}` : `Speaker ${id}`;
}
