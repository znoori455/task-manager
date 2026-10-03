import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  // Per-project sequencer: incremented under a row lock for every event.
  version: bigint("version", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status").notNull(),
    assignedTo: text("assigned_to").array().notNull().default(sql`'{}'`),
    priority: text("priority").notNull(),
    description: text("description").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'`),
    customFields: jsonb("custom_fields").$type<Record<string, string | number | boolean>>().notNull().default({}),
    dependencies: text("dependencies").array().notNull().default(sql`'{}'`),
    commentCount: integer("comment_count").notNull().default(0),
    version: bigint("version", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    // Cursor pagination of live tasks within a project: WHERE project_id = ? AND id > ? ORDER BY id.
    index("tasks_project_live_id_idx").on(t.projectId, t.id).where(sql`${t.deletedAt} IS NULL`),
    // Server-side filtering by status (board columns, counts).
    index("tasks_project_status_idx").on(t.projectId, t.status).where(sql`${t.deletedAt} IS NULL`),
    // "Which tasks are tagged X / assigned to Y / depend on Z" lookups.
    index("tasks_tags_gin_idx").using("gin", t.tags),
    index("tasks_assigned_gin_idx").using("gin", t.assignedTo),
    index("tasks_dependencies_gin_idx").using("gin", t.dependencies),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    author: text("author").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [index("comments_task_time_idx").on(t.taskId, t.timestamp)],
);

// Append-only event log. (project_id, seq) is the primary key, which both
// enforces a gap-free total order per project and serves replay queries.
export const events = pgTable(
  "events",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    actor: text("actor").notNull(),
    clientMutationId: text("client_mutation_id"),
    timestamp: timestamp("timestamp", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.seq] }),
    // Idempotent retries: a resent mutation returns its original events.
    index("events_project_mutation_idx").on(t.projectId, t.clientMutationId),
  ],
);
