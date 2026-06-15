import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { TranscriptTurnResult } from '../adapters/transcription/types.js';

/**
 * Structuring & auto-tagging via Claude (PRD F4, Stage 3).
 *
 * Claude operates ONLY on the transcript text (Step B of the two-step pipeline —
 * no audio ever reaches the model). Output is constrained to a strict schema via
 * structured outputs (`output_config.format`), so we never hand-parse free text:
 * the SDK validates against the schema and the model retries on mismatch. A
 * thrown error after retries routes the recording to the review queue (parse
 * failure) while the transcript stays keyword-searchable (PRD edge case 5).
 */

// ── Output schema (kept within structured-output constraints: no min/max len) ──
const StructuredOutput = z.object({
  summary: z.string().describe('One-paragraph summary of the call.'),
  topicTag: z
    .string()
    .describe('A short topic label, e.g. "Q3 budget review" or "creative feedback".'),
  actionItems: z
    .array(
      z.object({
        text: z.string().describe('The action to be taken.'),
        ownerLabel: z
          .string()
          .describe('Speaker label responsible, e.g. "Speaker 2", or "" if unclear.'),
        dueText: z
          .string()
          .describe('Any due date/timeframe mentioned verbatim, or "" if none.'),
      }),
    )
    .describe('Action items; empty array is valid if none were committed.'),
  decisions: z
    .array(z.object({ text: z.string() }))
    .describe('Decisions made during the call; empty array if none.'),
  financialLegalTurnIndices: z
    .array(z.number().int())
    .describe(
      'Indices (0-based, matching the numbered turns provided) of turns that ' +
        'discuss GST, pricing, invoicing, agreements, payments, or other ' +
        'financial/legal matters. Used to hide those segments from Design & Video.',
    ),
  multiClient: z
    .boolean()
    .describe('True if the call clearly spans more than one distinct client.'),
  tagConfidence: z
    .enum(['high', 'low'])
    .describe('Your confidence that this call is correctly about a single client/project.'),
});

export type StructuredOutput = z.infer<typeof StructuredOutput>;

export interface StructuringContext {
  clientName: string;
  projectName: string;
}

const SYSTEM_PROMPT = `You are the structuring engine for Futuready's meeting knowledge base.
You receive a transcript of a business meeting (often code-mixed Hindi/Marathi/English — "Hinglish"; you read it fluently). You extract structured knowledge from the TEXT only.

Rules:
- Summary: one tight paragraph a busy colleague can read in 15 seconds.
- Action items: only real commitments. Attribute to the speaker label when clear. Capture any stated due date verbatim in dueText; otherwise "".
- Decisions: concrete decisions reached, not discussion points.
- financialLegalTurnIndices: flag every turn touching GST, pricing, invoicing, agreements, payments, budgets-as-money, or legal terms. Be inclusive — these segments are hidden from the Design & Video team, so a false negative leaks sensitive content.
- multiClient: true only if two or more clearly distinct clients are discussed.
- tagConfidence: "low" if the call is ambiguous, off-topic for the assigned client/project, or spans multiple clients.
Return ONLY the structured object.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

function buildUserPrompt(turns: TranscriptTurnResult[], ctx: StructuringContext): string {
  const numbered = turns
    .map((t, i) => `[${i}] ${t.speakerLabel}: ${t.text}`)
    .join('\n');
  return `Assigned client: ${ctx.clientName}
Assigned project: ${ctx.projectName}

Transcript (turns are numbered for financialLegalTurnIndices):
${numbered}`;
}

/**
 * Structure a transcript. Returns the validated object, or throws after the
 * SDK's built-in retries are exhausted (caller routes to review queue).
 *
 * When ANTHROPIC_API_KEY is absent (local dev with the mock engine), returns a
 * deterministic heuristic structuring so the whole pipeline still reaches
 * `ready` without a paid API call.
 */
export async function structureTranscript(
  turns: TranscriptTurnResult[],
  ctx: StructuringContext,
): Promise<StructuredOutput> {
  if (!config.ANTHROPIC_API_KEY) {
    logger.warn('ANTHROPIC_API_KEY missing — using heuristic structuring (dev only)');
    return heuristicStructuring(turns);
  }

  const res = await getClient().beta.messages.parse({
    model: config.CLAUDE_MODEL,
    max_tokens: 4096,
    output_config: {
      effort: config.CLAUDE_EFFORT,
      format: betaZodOutputFormat(StructuredOutput),
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(turns, ctx) }],
  });

  if (res.stop_reason === 'refusal') {
    throw new Error('Claude refused the structuring request');
  }
  const parsed = res.parsed_output;
  if (!parsed) throw new Error('Claude returned no parseable structured output');
  return parsed;
}

/** Dependency-free fallback so the pipeline runs end-to-end without a key. */
function heuristicStructuring(turns: TranscriptTurnResult[]): StructuredOutput {
  const FIN = /\b(gst|invoice|invoicing|pricing|price|budget|payment|agreement|contract|legal|₹|rs\.?|rupees)\b/i;
  const financialLegalTurnIndices = turns
    .map((t, i) => (FIN.test(t.text) ? i : -1))
    .filter((i) => i >= 0);
  const decisions = turns
    .filter((t) => /\bdecision\b|\bwe (will|move|decide)\b/i.test(t.text))
    .map((t) => ({ text: t.text }));
  const actionItems = turns
    .filter((t) => /\b(let us|let's|by friday|by monday|reduce|reallocate|send|follow up)\b/i.test(t.text))
    .map((t) => ({ text: t.text, ownerLabel: t.speakerLabel, dueText: '' }));

  return {
    summary:
      turns.length > 0
        ? `Auto-summary (heuristic): ${turns[0]!.text.slice(0, 200)}`
        : 'Empty transcript.',
    topicTag: 'general',
    actionItems,
    decisions,
    financialLegalTurnIndices,
    multiClient: false,
    tagConfidence: 'high',
  };
}
