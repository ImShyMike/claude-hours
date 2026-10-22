-- What the mod sends gets a leading _, so it sorts apart from the accounts.
-- Renamed in place (tables, their keys, indexes and id sequences), data kept
ALTER TABLE "runs" RENAME TO "_runs";
--> statement-breakpoint
ALTER TABLE "quarantine" RENAME TO "_quarantine";
--> statement-breakpoint
ALTER TABLE "session_starts" RENAME TO "_session_starts";
--> statement-breakpoint
ALTER TABLE "session_ends" RENAME TO "_session_ends";
--> statement-breakpoint
ALTER TABLE "prompts" RENAME TO "_prompts";
--> statement-breakpoint
ALTER TABLE "abandoned_drafts" RENAME TO "_abandoned_drafts";
--> statement-breakpoint
ALTER TABLE "turn_ends" RENAME TO "_turn_ends";
--> statement-breakpoint
ALTER TABLE "interrupts" RENAME TO "_interrupts";
--> statement-breakpoint
ALTER TABLE "compacts" RENAME TO "_compacts";
--> statement-breakpoint
ALTER TABLE "tool_calls" RENAME TO "_tool_calls";
--> statement-breakpoint
ALTER TABLE "file_changes" RENAME TO "_file_changes";
--> statement-breakpoint
ALTER TABLE "cwd_changes" RENAME TO "_cwd_changes";
--> statement-breakpoint
ALTER TABLE "other_events" RENAME TO "_other_events";
--> statement-breakpoint
ALTER TABLE "draft_timelines" RENAME TO "_draft_timelines";
--> statement-breakpoint
ALTER TABLE "_runs" RENAME CONSTRAINT "runs_pkey" TO "_runs_pkey";
--> statement-breakpoint
ALTER TABLE "_runs" RENAME CONSTRAINT "runs_person_id_people_id_fk" TO "_runs_person_id_people_id_fk";
--> statement-breakpoint
ALTER SEQUENCE "runs_id_seq" RENAME TO "_runs_id_seq";
--> statement-breakpoint
ALTER TABLE "_quarantine" RENAME CONSTRAINT "quarantine_pkey" TO "_quarantine_pkey";
--> statement-breakpoint
ALTER TABLE "_quarantine" RENAME CONSTRAINT "quarantine_person_id_people_id_fk" TO "_quarantine_person_id_people_id_fk";
--> statement-breakpoint
ALTER SEQUENCE "quarantine_id_seq" RENAME TO "_quarantine_id_seq";
--> statement-breakpoint
ALTER TABLE "_session_starts" RENAME CONSTRAINT "session_starts_run_id_n_pk" TO "_session_starts_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_session_starts" RENAME CONSTRAINT "session_starts_run_id_runs_id_fk" TO "_session_starts_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_session_ends" RENAME CONSTRAINT "session_ends_run_id_n_pk" TO "_session_ends_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_session_ends" RENAME CONSTRAINT "session_ends_run_id_runs_id_fk" TO "_session_ends_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_prompts" RENAME CONSTRAINT "prompts_run_id_n_pk" TO "_prompts_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_prompts" RENAME CONSTRAINT "prompts_run_id_runs_id_fk" TO "_prompts_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_abandoned_drafts" RENAME CONSTRAINT "abandoned_drafts_run_id_n_pk" TO "_abandoned_drafts_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_abandoned_drafts" RENAME CONSTRAINT "abandoned_drafts_run_id_runs_id_fk" TO "_abandoned_drafts_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_turn_ends" RENAME CONSTRAINT "turn_ends_run_id_n_pk" TO "_turn_ends_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_turn_ends" RENAME CONSTRAINT "turn_ends_run_id_runs_id_fk" TO "_turn_ends_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_interrupts" RENAME CONSTRAINT "interrupts_run_id_n_pk" TO "_interrupts_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_interrupts" RENAME CONSTRAINT "interrupts_run_id_runs_id_fk" TO "_interrupts_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_compacts" RENAME CONSTRAINT "compacts_run_id_n_pk" TO "_compacts_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_compacts" RENAME CONSTRAINT "compacts_run_id_runs_id_fk" TO "_compacts_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_tool_calls" RENAME CONSTRAINT "tool_calls_run_id_n_pk" TO "_tool_calls_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_tool_calls" RENAME CONSTRAINT "tool_calls_run_id_runs_id_fk" TO "_tool_calls_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_file_changes" RENAME CONSTRAINT "file_changes_run_id_n_pk" TO "_file_changes_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_file_changes" RENAME CONSTRAINT "file_changes_run_id_runs_id_fk" TO "_file_changes_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_cwd_changes" RENAME CONSTRAINT "cwd_changes_run_id_n_pk" TO "_cwd_changes_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_cwd_changes" RENAME CONSTRAINT "cwd_changes_run_id_runs_id_fk" TO "_cwd_changes_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_other_events" RENAME CONSTRAINT "other_events_run_id_n_pk" TO "_other_events_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_other_events" RENAME CONSTRAINT "other_events_run_id_runs_id_fk" TO "_other_events_run_id__runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_draft_timelines" RENAME CONSTRAINT "draft_timelines_run_id_n_pk" TO "_draft_timelines_run_id_n_pk";
--> statement-breakpoint
ALTER TABLE "_draft_timelines" RENAME CONSTRAINT "draft_timelines_run_id_runs_id_fk" TO "_draft_timelines_run_id__runs_id_fk";
--> statement-breakpoint
ALTER INDEX "runs_key" RENAME TO "_runs_key";
--> statement-breakpoint
ALTER INDEX "quarantine_person_idx" RENAME TO "_quarantine_person_idx";
--> statement-breakpoint
-- Postgres 18 names each NOT NULL too (older versions have none to rename)
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT k.conname, t.relname FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
    WHERE k.contype = 'n' AND t.relname LIKE '\_%' AND t.relnamespace = 'public'::regnamespace AND k.conname NOT LIKE '\_%'
  LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', c.relname, c.conname, '_' || c.conname);
  END LOOP;
END $$;
