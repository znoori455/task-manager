// OpenAPI 3.1 document generated from the same zod schemas the server uses to
// validate requests, so the docs can't drift from the implementation.
import { z } from "zod";
import { commandRequestSchema, createProjectSchema, customFieldValue, markReadSchema, prioritySchema, sessionSchema, statusSchema } from "./schemas";

const project = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  version: z.number().int().describe("Seq of the last event in this project's log"),
  createdAt: z.string(),
  updatedAt: z.string().describe("Time of the last event; the project list is sorted by it"),
});
const task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: statusSchema,
  assignedTo: z.array(z.string()),
  configuration: z.object({
    priority: prioritySchema,
    description: z.string(),
    tags: z.array(z.string()),
    customFields: z.record(z.string(), customFieldValue),
  }),
  dependencies: z.array(z.string()),
  commentCount: z.number().int(),
  version: z.number().int().describe("Seq of the last event that touched this task"),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
const comment = z.object({ id: z.string(), taskId: z.string(), content: z.string(), author: z.string(), timestamp: z.string() });
const event = z.object({
  type: z.string().describe("e.g. task.created, task.updated, comment.added — see src/domain/events.ts"),
  payload: z.record(z.string(), z.unknown()),
  projectId: z.string(),
  seq: z.number().int(),
  actor: z.string(),
  clientMutationId: z.string().nullable(),
  timestamp: z.string(),
});
const error = z.object({ error: z.object({ code: z.string(), message: z.string(), issues: z.unknown().optional() }) });

const schemas = { Project: project, Task: task, Comment: comment, Event: event, Error: error, CommandRequest: commandRequestSchema };
const toSchema = (s: z.ZodType) => {
  const { $schema, ...rest } = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  void $schema;
  return rest;
};
const ref = (name: keyof typeof schemas) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ content: { "application/json": { schema } } });
const ok = (schema: object, description = "OK") => ({ description, ...json(schema) });
const errors = { "4XX": { description: "Error", ...json(ref("Error")) } };
const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Taskflow API",
      version: "1.0.0",
      description:
        "All writes go through `POST /api/projects/{id}/commands`. Each accepted command appends events to the project's log; clients receive them over the SSE stream. Identify yourself with the `tf_user` cookie (set via `POST /api/session`).",
    },
    paths: {
      "/api/session": {
        get: { summary: "Current display name", responses: { 200: ok({ type: "object", properties: { name: { type: ["string", "null"] } } }) } },
        post: { summary: "Set display name (cookie)", requestBody: json(toSchema(sessionSchema)), responses: { 200: ok({ type: "object" }), ...errors } },
        delete: { summary: "Clear the display name (switch user)", responses: { 200: ok({ type: "object" }) } },
      },
      "/api/projects": {
        get: {
          summary: "List projects, most recently updated first (keyset pagination)",
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" }, description: "nextCursor from the previous page" },
            { name: "limit", in: "query", schema: { type: "integer", default: 30, maximum: 100 } },
          ],
          responses: { 200: ok({ type: "object", properties: { projects: { type: "array", items: ref("Project") }, nextCursor: { type: ["string", "null"] } } }) },
        },
        post: { summary: "Create a project", requestBody: json(toSchema(createProjectSchema)), responses: { 201: ok({ type: "object", properties: { project: ref("Project") } }), ...errors } },
      },
      "/api/projects/changes": {
        get: {
          summary: "Projects updated or deleted since a time (offline catch-up)",
          description: "Served from Redis sorted sets (projects by last update, plus deletion tombstones kept 30 days). `reset: true` means reload the list.",
          parameters: [{ name: "since", in: "query", required: true, schema: { type: "integer" }, description: "`now` from the previous response, in ms" }],
          responses: {
            200: ok({
              type: "object",
              properties: { now: { type: "integer" }, projects: { type: "array", items: ref("Project") }, deleted: { type: "array", items: { type: "string" } }, reset: { type: "boolean" } },
            }),
          },
        },
      },
      "/api/projects/stream": {
        get: { summary: "SSE: project list changes", responses: { 200: { description: "text/event-stream" } } },
      },
      "/api/projects/{id}": {
        parameters: [idParam],
        get: { summary: "Project metadata (no tasks)", responses: { 200: ok({ type: "object", properties: { project: ref("Project") } }), ...errors } },
        delete: { summary: "Delete a project", responses: { 200: ok({ type: "object" }), ...errors } },
      },
      "/api/projects/{id}/tasks": {
        parameters: [idParam],
        get: {
          summary: "Task feed, most recently updated first (keyset pagination on updated_at, id)",
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" }, description: "nextCursor from the previous page" },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 1000 } },
            { name: "status", in: "query", schema: { type: "string", enum: ["todo", "in_progress", "in_review", "done"] } },
            { name: "assignee", in: "query", schema: { type: "string" } },
            { name: "q", in: "query", schema: { type: "string" }, description: "Title substring (case-insensitive) or exact tag" },
            { name: "ids", in: "query", schema: { type: "string" }, description: "Comma-separated ids (max 200): fetch specific tasks instead, including deleted ones" },
          ],
          responses: {
            200: ok({
              type: "object",
              properties: { tasks: { type: "array", items: ref("Task") }, nextCursor: { type: ["string", "null"] }, version: { type: "integer" } },
            }),
          },
        },
      },
      "/api/projects/{id}/tasks/counts": {
        parameters: [idParam],
        get: {
          summary: "Live task counts per status for a filter",
          parameters: [
            { name: "assignee", in: "query", schema: { type: "string" } },
            { name: "q", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: ok({ type: "object", properties: { total: { type: "integer" }, byStatus: { type: "object", additionalProperties: { type: "integer" } } } }) },
        },
      },
      "/api/projects/{id}/changes": {
        parameters: [idParam],
        get: {
          summary: "Tasks changed since a version (offline catch-up)",
          description:
            "Current rows (including soft-deleted) of every task changed after `since`. Ids come from a Redis sorted set (task id -> seq of last change) with a Postgres fallback for anything the index hasn't confirmed. Resume the SSE stream from the returned `version`. `reset: true` means too much changed; reload.",
          parameters: [{ name: "since", in: "query", required: true, schema: { type: "integer" }, description: "Last project version the client has" }],
          responses: {
            200: ok({
              type: "object",
              properties: {
                version: { type: "integer" },
                tasks: { type: "array", items: ref("Task") },
                reset: { type: "boolean" },
                source: { type: "object", properties: { index: { type: "integer" }, fallback: { type: "integer" }, rebuilt: { type: "boolean" } } },
              },
            }),
            ...errors,
          },
        },
      },
      "/api/projects/{id}/commands": {
        parameters: [idParam],
        post: {
          summary: "Execute a command (the only write endpoint)",
          description:
            "Validated and applied in one transaction. Idempotent per clientMutationId. Rate limited per user (429 + Retry-After). 422 for business-rule violations (invalid transition, blocked, cycle).",
          requestBody: json(ref("CommandRequest")),
          responses: { 200: ok({ type: "object", properties: { events: { type: "array", items: ref("Event") }, version: { type: "integer" } } }), ...errors },
        },
      },
      "/api/projects/{id}/stream": {
        parameters: [idParam],
        get: {
          summary: "SSE: live events for a project",
          description:
            "Default `message` events carry one Event each, with `id: <seq>`. Resumes after the `Last-Event-ID` header or `?since=`. Other event types: `ready`, `resync` (too far behind; catch up via /changes). Presence, cursors and typing are on the WebSocket service (`realtime/`), not here.",
          parameters: [{ name: "since", in: "query", schema: { type: "integer" } }],
          responses: { 200: { description: "text/event-stream" } },
        },
      },
      "/api/projects/{id}/events": {
        parameters: [idParam],
        get: {
          summary: "Event log, newest first (activity feed)",
          parameters: [
            { name: "before", in: "query", schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          ],
          responses: { 200: ok({ type: "object", properties: { events: { type: "array", items: ref("Event") } } }) },
        },
      },
      "/api/projects/{id}/tasks/{taskId}/comments": {
        parameters: [idParam, { name: "taskId", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Comment thread for a task", responses: { 200: ok({ type: "object", properties: { comments: { type: "array", items: ref("Comment") } } }) } },
      },
      "/api/notifications": {
        get: {
          summary: "Your notifications, newest first, plus the unread count",
          description: "Created in the same transaction as the change that caused them (mentions, assignments, comments and status changes on tasks assigned to you). Pushed live over the WebSocket service.",
          parameters: [
            { name: "before", in: "query", schema: { type: "string" }, description: "createdAt of the last item from the previous page" },
            { name: "limit", in: "query", schema: { type: "integer", default: 30, maximum: 100 } },
          ],
          responses: { 200: ok({ type: "object", properties: { notifications: { type: "array", items: { type: "object" } }, unread: { type: "integer" } } }), ...errors },
        },
        delete: { summary: "Clear all of your notifications", responses: { 200: ok({ type: "object", properties: { unread: { type: "integer" } } }), ...errors } },
      },
      "/api/notifications/{notificationId}": {
        delete: {
          summary: "Remove one of your notifications",
          parameters: [{ name: "notificationId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: ok({ type: "object", properties: { unread: { type: "integer" } } }), ...errors },
        },
      },
      "/api/notifications/read": {
        post: {
          summary: "Mark notifications read (all of them when `ids` is omitted)",
          requestBody: json(toSchema(markReadSchema)),
          responses: { 200: ok({ type: "object", properties: { unread: { type: "integer" } } }), ...errors },
        },
      },
    },
    components: { schemas: Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, toSchema(v)])) },
  };
}
