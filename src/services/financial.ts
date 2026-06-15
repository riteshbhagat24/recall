/**
 * Centralized Financial/Legal detection + redaction (PRD §3, REQ-12.2).
 *
 * Segment-level tagging on transcript turns/embeddings is authoritative (set by
 * Claude during structuring). This module is the SAFETY NET for the derived
 * artifacts that don't carry a per-row tag in the same way — decisions, action
 * items, and L2 summary prose — so Design & Video never receive financial
 * content through ANY surface (transcript, search, conversation view, context
 * pack, living summary).
 */
export const FINANCIAL_RE =
  /\b(gst|invoice|invoicing|pricing|price|budget|payment|pay(?:able|ment)?|agreement|contract|legal|tax|quotation|quote|cost|fees?|rupees?|₹|rs\.?)\b/i;

/** True if a short text (a decision/action item) is financial/legal. */
export function isFinancialText(text: string): boolean {
  return FINANCIAL_RE.test(text);
}

/**
 * Remove sentences containing financial markers from prose (e.g. an L2 living
 * summary) before showing it to a financial-blocked role. Conservative: drops
 * the whole sentence on any marker hit.
 */
export function redactFinancialProse(text: string): string {
  const kept = text
    .split(/(?<=[.!?\n])\s+/)
    .filter((sentence) => !FINANCIAL_RE.test(sentence));
  const result = kept.join(' ').trim();
  return result.length > 0 ? result : '_(content restricted for this role)_';
}
