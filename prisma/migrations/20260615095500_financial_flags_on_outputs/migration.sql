-- Add segment-level Financial/Legal flags to derived outputs so Design & Video
-- never receive financial decisions/action items via any surface (REQ-12.2).
ALTER TABLE "action_items" ADD COLUMN "is_financial_legal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "decisions" ADD COLUMN "is_financial_legal" BOOLEAN NOT NULL DEFAULT false;
