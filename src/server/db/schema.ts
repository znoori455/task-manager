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
  // Bumped by every event in the project; the project list is sorted by it.
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (t) => [
  // Project list keyset pagination: ORDER BY updated_at DESC, id DESC (a backward
  // scan of this ascending index; an explicit DESC would get NULLS LAST and not match).
  index("projects_updated_idx").on(t.updatedAt, t.id),
]);

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
    // Task feed keyset pagination: WHERE project_id = ? AND (updated_at, id) < cursor ORDER BY updated_at DESC, id DESC.
    // Ascending on purpose: scanned backward it yields exactly DESC (NULLS FIRST) order.
    index("tasks_project_updated_idx").on(t.projectId, t.updatedAt, t.id).where(sql`${t.deletedAt} IS NULL`),
    // Catch-up fallback when the Redis change index is behind: WHERE project_id = ? AND version > ?.
    index("tasks_project_version_idx").on(t.projectId, t.version),
    // Server-side search: title ILIKE '%q%' (needs the pg_trgm extension, see drizzle/0001).
    index("tasks_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
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
