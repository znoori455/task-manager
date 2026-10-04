DROP INDEX "projects_updated_idx";--> statement-breakpoint
DROP INDEX "tasks_project_updated_idx";--> statement-breakpoint
CREATE INDEX "projects_updated_idx" ON "projects" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "tasks_project_updated_idx" ON "tasks" USING btree ("project_id","updated_at","id") WHERE "tasks"."deleted_at" IS NULL;