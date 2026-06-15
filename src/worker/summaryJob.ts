import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { pipelineLogger } from '../logger.js';
import { audit } from '../audit.js';
import type { EntityType } from '@prisma/client';
import type { SummaryRefreshJobData } from '../pipeline/queues.js';

/**
 * Stage 4 — Memory (PRD §8, F-MEM L2). Regenerates the living summary for the
 * affected client AND project after each new call. Prior versions are retained
 * (versioned, last-write-wins + version row — PRD edge case L2 race).
 */
export async function runSummaryRefreshJob(data: SummaryRefreshJobData): Promise<void> {
  const log = pipelineLogger(data.correlationId, 0);
  await regenerate('client', data.clientId);
  await regenerate('project', data.projectId);
  log.info({ clientId: data.clientId, projectId: data.projectId }, 'L2 summaries refreshed');
}

async function regenerate(entityType: EntityType, entityId: number): Promise<void> {
  const conversations = await prisma.conversation.findMany({
    where: entityType === 'client' ? { clientId: entityId } : { projectId: entityId },
    orderBy: { createdAt: 'desc' },
    take: 50, // bound the context; most recent calls dominate the living summary
    include: { decisions: true, actionItems: { where: { status: 'open' } } },
  });
  if (conversations.length === 0) return;

  const summaryText = await composeSummary(entityType, conversations);

  // last-write-wins + version row: read current head, write a new version that
  // points back to it.
  const prev = await prisma.entitySummary.findFirst({
    where: { entityType, entityId },
    orderBy: { version: 'desc' },
  });
  const created = await prisma.entitySummary.create({
    data: {
      entityType,
      entityId,
      summary: summaryText,
      version: (prev?.version ?? 0) + 1,
      prevVersionId: prev?.id ?? null,
    },
  });
  await audit({
    action: 'summary_refreshed',
    subjectType: `entity_summary:${entityType}`,
    subjectId: entityId,
    meta: { version: created.version },
  });
}

type ConvForSummary = {
  title: string;
  summary: string;
  topicTag: string | null;
  decisions: { text: string }[];
  actionItems: { text: string }[];
};

async function composeSummary(
  entityType: EntityType,
  conversations: ConvForSummary[],
): Promise<string> {
  // Without a key (dev), deterministically concatenate — keeps the pipeline whole.
  if (!config.ANTHROPIC_API_KEY) {
    const lines = conversations.slice(0, 10).map(
      (c) => `- ${c.title} (${c.topicTag ?? 'general'}): ${c.summary}`,
    );
    return `Living ${entityType} summary (heuristic, ${conversations.length} calls):\n${lines.join('\n')}`;
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const corpus = conversations
    .map(
      (c) =>
        `Call: ${c.title}\nTopic: ${c.topicTag ?? ''}\nSummary: ${c.summary}\n` +
        `Decisions: ${c.decisions.map((d) => d.text).join('; ')}\n` +
        `Open actions: ${c.actionItems.map((a) => a.text).join('; ')}`,
    )
    .join('\n\n---\n\n');

  const res = await client.beta.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 1500,
    output_config: { effort: config.CLAUDE_EFFORT },
    system: `You maintain a living, canonical summary of everything known about a ${entityType}. Synthesize the calls into a clear briefing: current status, key decisions, open commitments, and notable context. Be concise and factual. Output plain text.`,
    messages: [{ role: 'user', content: `Calls (newest first):\n\n${corpus}` }],
  });
  const block = res.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : 'Summary unavailable.';
}
