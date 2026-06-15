import type { Role, User } from '@prisma/client';
import { prisma } from '../db.js';

/**
 * Authorization (PRD §3, §12). Enforced SERVER-SIDE at the query layer — never
 * UI-only (REQ-12.2). Two granularities of Financial/Legal exclusion:
 *   1. whole recording/conversation, and
 *   2. individual transcript_turns / embeddings tagged financial,
 * so Design & Video never receive financial passages even inside a permitted call.
 */

export type Actor = Pick<User, 'id' | 'role'>;

/** Roles allowed to upload / trigger capture (PRD §3). */
const UPLOAD_ROLES = new Set<Role>([
  'super_admin',
  'admin_cs_lead',
  'bd',
  'cs',
  'performance',
]);

/** Roles allowed to edit/correct structured outputs & transcripts (PRD §3). */
const EDIT_ROLES = new Set<Role>(['super_admin', 'admin_cs_lead', 'cs']);

/** Roles allowed to change engine config / clear review queue (PRD F10). */
const CONFIG_ROLES = new Set<Role>(['super_admin', 'admin_cs_lead', 'bd']);

/** Roles that must NEVER receive Financial/Legal-tagged content (PRD §3). */
const FINANCIAL_BLOCKED = new Set<Role>(['design_video']);

export function canUpload(actor: Actor): boolean {
  return UPLOAD_ROLES.has(actor.role);
}
export function canEditOutputs(actor: Actor): boolean {
  return EDIT_ROLES.has(actor.role);
}
export function canManageConfig(actor: Actor): boolean {
  return CONFIG_ROLES.has(actor.role);
}
export function isAdmin(actor: Actor): boolean {
  return actor.role === 'super_admin' || actor.role === 'admin_cs_lead';
}

/** True if the actor's role must never see Financial/Legal segments. */
export function isFinancialBlocked(actor: Actor): boolean {
  return FINANCIAL_BLOCKED.has(actor.role);
}

/**
 * Client-scope visibility. Performance team sees only assigned clients; every
 * other role sees all clients (PRD §3). Returns:
 *   - null  → unrestricted (all clients)
 *   - number[] → the allowed client ids
 */
export async function visibleClientIds(actor: Actor): Promise<number[] | null> {
  if (actor.role !== 'performance') return null;
  const rows = await prisma.clientAssignment.findMany({
    where: { userId: actor.id },
    select: { clientId: true },
  });
  return rows.map((r) => r.clientId);
}

/** Can this actor see a given client at all? */
export async function canAccessClient(actor: Actor, clientId: number): Promise<boolean> {
  const allowed = await visibleClientIds(actor);
  return allowed === null || allowed.includes(clientId);
}

/**
 * A Prisma `where` fragment that scopes a query to the actor's visible clients.
 * Spread into a findMany where-clause. Empty object = unrestricted.
 */
export async function clientScopeWhere(
  actor: Actor,
): Promise<{ clientId?: { in: number[] } }> {
  const allowed = await visibleClientIds(actor);
  if (allowed === null) return {};
  return { clientId: { in: allowed.length ? allowed : [-1] } }; // [-1] = match nothing
}
