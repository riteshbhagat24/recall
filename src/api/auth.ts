import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { config } from '../config.js';
import type { Actor } from '../services/permissions.js';

/**
 * Auth shim (PRD §12, REQ-12.1). In production this reuses the onboarding
 * system's session-based auth + role model — there is NO separate user store.
 * For local dev the API trusts an `x-user-id` header resolved against the
 * seeded users table. Authorization is always enforced server-side per request.
 */
declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

export async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!config.DEV_AUTH_TRUST_HEADER) {
    reply.code(501).send({ ok: false, code: 'UNAUTHENTICATED', message: 'session auth not wired in this build' });
    return;
  }
  const header = req.headers['x-user-id'];
  const userId = Array.isArray(header) ? header[0] : header;
  if (!userId) {
    reply.code(401).send({ ok: false, code: 'UNAUTHENTICATED', message: 'missing x-user-id' });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { id: true, role: true },
  });
  if (!user) {
    reply.code(401).send({ ok: false, code: 'UNAUTHENTICATED', message: 'unknown user' });
    return;
  }
  req.actor = { id: user.id, role: user.role };
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw new Error('actor missing — authenticate hook not run');
  return req.actor;
}

export function forbidden(reply: FastifyReply, message = 'forbidden') {
  return reply.code(403).send({ ok: false, code: 'FORBIDDEN', message });
}
