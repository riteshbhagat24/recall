-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('super_admin', 'admin_cs_lead', 'bd', 'finance', 'cs', 'performance', 'design_video');

-- CreateEnum
CREATE TYPE "RecordingSource" AS ENUM ('meet_bot', 'upload', 'phone', 'in_person');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('captured', 'transcribing', 'transcribed', 'structuring', 'ready', 'capture_failed', 'transcription_failed', 'structure_failed');

-- CreateEnum
CREATE TYPE "ConsentState" AS ENUM ('not_set', 'informed', 'explicit', 'declined');

-- CreateEnum
CREATE TYPE "TagConfidence" AS ENUM ('high', 'low');

-- CreateEnum
CREATE TYPE "ActionItemStatus" AS ENUM ('open', 'done');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('client', 'project');

-- CreateEnum
CREATE TYPE "WorkspaceItemType" AS ENUM ('chat', 'note', 'prompt', 'extraction');

-- CreateEnum
CREATE TYPE "ReviewReason" AS ENUM ('low_tag_confidence', 'multi_client', 'parse_failure', 'unsupported_language');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_assignments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "client_id" INTEGER NOT NULL,

    CONSTRAINT "client_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recordings" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "source" "RecordingSource" NOT NULL,
    "storage_path" TEXT NOT NULL,
    "title" TEXT,
    "meeting_date" TIMESTAMP(3),
    "duration_sec" INTEGER,
    "checksum" TEXT,
    "status" "RecordingStatus" NOT NULL DEFAULT 'captured',
    "failure_reason" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" SERIAL NOT NULL,
    "recording_id" INTEGER NOT NULL,
    "engine_used" TEXT NOT NULL,
    "language_summary" TEXT,
    "full_text" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_turns" (
    "id" SERIAL NOT NULL,
    "transcript_id" INTEGER NOT NULL,
    "speaker_label" TEXT NOT NULL,
    "start_ts" DOUBLE PRECISION NOT NULL,
    "end_ts" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "detected_lang" TEXT,
    "is_financial_legal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "transcript_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "recording_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "topic_tag" TEXT,
    "summary" TEXT NOT NULL,
    "tag_confidence" "TagConfidence" NOT NULL DEFAULT 'high',
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_items" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "owner_label" TEXT,
    "due_text" TEXT,
    "status" "ActionItemStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_summaries" (
    "id" SERIAL NOT NULL,
    "entity_type" "EntityType" NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "prev_version_id" INTEGER,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_workspaces" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_items" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "type" "WorkspaceItemType" NOT NULL,
    "content" TEXT NOT NULL,
    "refs_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" SERIAL NOT NULL,
    "recording_id" INTEGER NOT NULL,
    "state" "ConsentState" NOT NULL DEFAULT 'not_set',
    "set_by" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_queue" (
    "id" SERIAL NOT NULL,
    "recording_id" INTEGER NOT NULL,
    "reason" "ReviewReason" NOT NULL,
    "detail" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolver_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "review_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_config" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engine_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "actor_id" INTEGER,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT,
    "ip" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embeddings" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "turn_id" INTEGER,
    "passage_text" TEXT NOT NULL,
    "embedding" vector(1536),
    "model_used" TEXT NOT NULL,
    "is_financial_legal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "projects_client_id_idx" ON "projects"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_assignments_user_id_client_id_key" ON "client_assignments"("user_id", "client_id");

-- CreateIndex
CREATE INDEX "recordings_client_id_project_id_status_idx" ON "recordings"("client_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_recording_id_key" ON "transcripts"("recording_id");

-- CreateIndex
CREATE INDEX "transcript_turns_transcript_id_idx" ON "transcript_turns"("transcript_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_recording_id_key" ON "conversations"("recording_id");

-- CreateIndex
CREATE INDEX "conversations_client_id_project_id_idx" ON "conversations"("client_id", "project_id");

-- CreateIndex
CREATE INDEX "action_items_conversation_id_idx" ON "action_items"("conversation_id");

-- CreateIndex
CREATE INDEX "decisions_conversation_id_idx" ON "decisions"("conversation_id");

-- CreateIndex
CREATE INDEX "entity_summaries_entity_type_entity_id_idx" ON "entity_summaries"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "user_workspaces_user_id_idx" ON "user_workspaces"("user_id");

-- CreateIndex
CREATE INDEX "workspace_items_workspace_id_idx" ON "workspace_items"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "consent_records_recording_id_key" ON "consent_records"("recording_id");

-- CreateIndex
CREATE INDEX "review_queue_resolved_idx" ON "review_queue"("resolved");

-- CreateIndex
CREATE UNIQUE INDEX "engine_config_key_key" ON "engine_config"("key");

-- CreateIndex
CREATE INDEX "audit_logs_subject_type_subject_id_idx" ON "audit_logs"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "embeddings_conversation_id_idx" ON "embeddings"("conversation_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_turns" ADD CONSTRAINT "transcript_turns_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_workspaces" ADD CONSTRAINT "user_workspaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_items" ADD CONSTRAINT "workspace_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "user_workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
