ALTER TABLE "device_tokens" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "_runs" ADD COLUMN "device_id" bigint;--> statement-breakpoint
ALTER TABLE "_runs" ADD CONSTRAINT "_runs_device_id_device_tokens_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_tokens"("id") ON DELETE set null ON UPDATE no action;