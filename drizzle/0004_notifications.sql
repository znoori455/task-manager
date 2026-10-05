CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient") WHERE "notifications"."read_at" IS NULL;