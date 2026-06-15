import { prisma } from '../db.js';
import { config } from '../config.js';
import type { Actor } from './permissions.js';
import { isFinancialBlocked } from './permissions.js';
import { redactFinancialProse } from './financial.js';
import { hybridSearch } from './search.js';

/**
 * Context-pack export (PRD F8, REQ-5.5). Produces a copyable markdown bundle for
 * a client/project: living summary + key decisions + open action items + top-N
 * relevant passages — permission-filtered, token-budget capped. Design & Video
 * never receive financial passages (enforced via hybridSearch's filtering).
 */
export async function buildContextPack(
  actor: Actor,
  opts: { clientId: number; projectId?: number; query?: string },
): Promise<string> {
  const client = await prisma.client.findUnique({ where: { id: opts.clientId } });
  if (!client) throw new Error('client not found');

  const entityType = opts.projectId ? 'project' : 'client';
  const entityId = opts.projectId ?? opts.clientId;
  const livingSummary = await prisma.entitySummary.findFirst({
    where: { entityType, entityId },
    orderBy: { version: 'desc' },
  });

  const blocked = isFinancialBlocked(actor);
  const convWhere = opts.projectId
    ? { clientId: opts.clientId, projectId: opts.projectId }
    : { clientId: opts.clientId };
  // Financial/Legal exclusion for Design & Video applied at the query layer.
  const financialFilter = blocked ? { isFinancialLegal: false } : {};

  const [decisions, openActions, passages] = await Promise.all([
    prisma.decision.findMany({
      where: { conversation: convWhere, ...financialFilter },
      orderBy: { createdAt: 'desc' },
      take: 15,
    }),
    prisma.actionItem.findMany({
      where: { conversation: convWhere, status: 'open', ...financialFilter },
      orderBy: { createdAt: 'desc' },
      take: 15,
    }),
    hybridSearch(
      actor,
      opts.query ?? 'key decisions risks budget timeline commitments',
      { client: opts.clientId, project: opts.projectId },
      8,
    ),
  ]);

  const lines: string[] = [];
  lines.push(`# Context Pack — ${client.name}${opts.projectId ? ` / project #${opts.projectId}` : ''}`);
  lines.push('');
  lines.push('## Living summary');
  const summaryText = livingSummary?.summary ?? '_No summary generated yet._';
  lines.push(blocked ? redactFinancialProse(summaryText) : summaryText);
  lines.push('');
  lines.push('## Key decisions');
  lines.push(decisions.length ? decisions.map((d) => `- ${d.text}`).join('\n') : '_None recorded._');
  lines.push('');
  lines.push('## Open action items');
  lines.push(
    openActions.length
      ? openActions.map((a) => `- ${a.text}${a.ownerLabel ? ` (${a.ownerLabel})` : ''}${a.dueText ? ` — due ${a.dueText}` : ''}`).join('\n')
      : '_None open._',
  );
  lines.push('');
  lines.push('## Relevant passages');
  lines.push(
    passages.length
      ? passages
          .map((p) => `- [${p.timestamp ?? '—'} ${p.speakerLabel ?? ''}] ${p.snippet}`)
          .join('\n')
      : '_No passages._',
  );

  return capToBudget(lines.join('\n'), config.CONTEXT_PACK_TOKEN_BUDGET);
}

/** Rough token cap (~4 chars/token). Trims from the end, preserving structure. */
function capToBudget(text: string, tokenBudget: number): string {
  const maxChars = tokenBudget * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…_(truncated to fit ${tokenBudget}-token budget)_`;
}
