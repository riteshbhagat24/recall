import { prisma } from './db.js';

export interface AuditEntry {
  actorId?: number | null;
  action: string;
  subjectType: string;
  subjectId?: string | number | null;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Append-only audit trail (PRD F9, REQ-5.9). Every sensitive action — views,
 * exports, edits, consent changes, engine-config changes — calls this.
 * Audit writes never throw into the caller's path; a failed log is logged, not
 * surfaced as a user error.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId != null ? String(entry.subjectId) : null,
        ip: entry.ip ?? null,
        meta: (entry.meta ?? undefined) as object | undefined,
      },
    });
  } catch (err) {
    // best-effort; do not break the request because audit insert failed
    const { logger } = await import('./logger.js');
    logger.error({ err, entry }, 'audit write failed');
  }
}
