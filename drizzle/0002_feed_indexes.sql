DROP INDEX "tasks_project_live_id_idx";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_updated_idx" ON "projects" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_project_updated_idx" ON "tasks" USING btree ("project_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "tasks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_project_version_idx" ON "tasks" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "tasks_title_trgm_idx" ON "tasks" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
UPDATE "projects" p SET "updated_at" = COALESCE((SELECT max(e."timestamp") FROM "events" e WHERE e."project_id" = p."id"), p."created_at");
