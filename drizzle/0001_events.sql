CREATE TABLE "abandoned_drafts" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"compose_ms" bigint,
	"typing_ms" bigint,
	"edits" integer,
	"typed_chars" integer,
	"pasted_chars" integer,
	"deleted_chars" integer,
	"fixes" integer,
	"rewrites" integer,
	"rewritten_chars" integer,
	"pauses" integer,
	"breaks" integer,
	"longest_pause_ms" bigint,
	"word_deletes" integer,
	"line_kills" integer,
	"draft_id" text,
	"how" text,
	"ended_at" bigint,
	"extra" jsonb,
	CONSTRAINT "abandoned_drafts_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "compacts" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"trigger" text,
	"agent_id" text,
	"messages" integer,
	"outcome" text,
	"tokens_before" integer,
	"tokens_after" integer,
	"usage" jsonb,
	"duration_ms" bigint,
	"extra" jsonb,
	CONSTRAINT "compacts_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "cwd_changes" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"cwd" text,
	"root" text,
	"root_name" text,
	"extra" jsonb,
	CONSTRAINT "cwd_changes_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "draft_timelines" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"v" integer,
	"draft_id" text,
	"outcome" text,
	"started_at" bigint,
	"duration_ms" bigint,
	"initial_shape" text,
	"initial_cursor" integer,
	"steps" text,
	"truncated" boolean,
	"extra" jsonb,
	CONSTRAINT "draft_timelines_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "file_changes" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"tool" text,
	"agent_id" text,
	"path" text,
	"via" text,
	"extra" jsonb,
	CONSTRAINT "file_changes_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "interrupts" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"turn_id" text,
	"agent_id" text,
	"reason" text,
	"duration_ms" bigint,
	"usage" jsonb,
	"waits" jsonb,
	"answer_chars" integer,
	"tools_running" jsonb,
	"extra" jsonb,
	CONSTRAINT "interrupts_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "other_events" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"event" text NOT NULL,
	"extra" jsonb,
	CONSTRAINT "other_events_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"words" integer,
	"chars" integer,
	"origin" text,
	"command" text,
	"is_meta" boolean,
	"mid_turn" boolean,
	"images" integer,
	"audio" integer,
	"documents" integer,
	"compose_ms" bigint,
	"typing_ms" bigint,
	"edits" integer,
	"typed_chars" integer,
	"pasted_chars" integer,
	"deleted_chars" integer,
	"fixes" integer,
	"rewrites" integer,
	"rewritten_chars" integer,
	"pauses" integer,
	"breaks" integer,
	"longest_pause_ms" bigint,
	"word_deletes" integer,
	"line_kills" integer,
	"draft_id" text,
	"extra" jsonb,
	CONSTRAINT "prompts_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "quarantine" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quarantine_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"person_id" bigint NOT NULL,
	"session" text NOT NULL,
	"stream" text NOT NULL,
	"start" bigint NOT NULL,
	"n" integer NOT NULL,
	"row" jsonb,
	"reason" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"person_id" bigint NOT NULL,
	"session" text NOT NULL,
	"stream" text NOT NULL,
	"start" bigint NOT NULL,
	"v" integer,
	"cwd" text,
	"root" text,
	"root_name" text,
	"header_extra" jsonb,
	"acked" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_ends" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"reason" text,
	"extra" jsonb,
	CONSTRAINT "session_ends_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "session_starts" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"surface" text,
	"is_interactive" boolean,
	"extra" jsonb,
	CONSTRAINT "session_starts_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"tool" text,
	"agent_id" text,
	"file" text,
	"repo" text,
	"repo_name" text,
	"command_chars" integer,
	"outcome" text,
	"duration_ms" bigint,
	"extra" jsonb,
	CONSTRAINT "tool_calls_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "turn_ends" (
	"run_id" bigint NOT NULL,
	"n" integer NOT NULL,
	"t" bigint,
	"at" bigint,
	"turn_id" text,
	"agent_id" text,
	"reason" text,
	"duration_ms" bigint,
	"usage" jsonb,
	"waits" jsonb,
	"answer_chars" integer,
	"tools_running" jsonb,
	"extra" jsonb,
	CONSTRAINT "turn_ends_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
ALTER TABLE "abandoned_drafts" ADD CONSTRAINT "abandoned_drafts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compacts" ADD CONSTRAINT "compacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cwd_changes" ADD CONSTRAINT "cwd_changes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_timelines" ADD CONSTRAINT "draft_timelines_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_changes" ADD CONSTRAINT "file_changes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interrupts" ADD CONSTRAINT "interrupts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_events" ADD CONSTRAINT "other_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine" ADD CONSTRAINT "quarantine_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ends" ADD CONSTRAINT "session_ends_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_starts" ADD CONSTRAINT "session_starts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_ends" ADD CONSTRAINT "turn_ends_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quarantine_person_idx" ON "quarantine" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_key" ON "runs" USING btree ("person_id","session","stream","start");