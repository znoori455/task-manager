// Type-safe API contract. Every request body and every event that crosses the
// wire is described here once; TS types are inferred from the schemas and the
// OpenAPI document is generated from them too.
import { z } from "zod";
import { PRIORITIES, TASK_STATUSES } from "@/domain/types";

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(64);
const tagList = z.array(z.string().trim().min(1).max(40)).max(50);
const userList = z.array(name).max(50);

export const statusSchema = z.enum(TASK_STATUSES);
export const prioritySchema = z.enum(PRIORITIES);
export const customFieldValue = z.union([z.string().max(1000), z.number(), z.boolean()]);

// ---------- Commands (client -> server intents) ----------

export const newTaskSchema = z.object({
  id,
  title: z.string().trim().min(1).max(500),
  status: statusSchema.optional(),
  assignedTo: userList.optional(),
  configuration: z
    .object({
      priority: prioritySchema.optional(),
      description: z.string().max(20_000).optional(),
      tags: tagList.optional(),
      customFields: z.record(z.string().max(64), customFieldValue).optional(),
    })
    .optional(),
  dependencies: z.array(id).max(100).optional(),
});

export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    status: statusSchema,
    priority: prioritySchema,
    description: z.string().max(20_000),
    /** Merged key by key; `null` removes a key. */
    customFields: z.record(z.string().max(64), customFieldValue.nullable()),
  })
  .partial();

const setDelta = (item: z.ZodType<string>) =>
  z.object({ taskId: id, add: z.array(item).max(50).default([]), remove: z.array(item).max(50).default([]) });

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.update"), patch: z.object({ name: name.optional(), description: z.string().max(5000).optional(), metadata: z.record(z.string(), z.unknown()).optional() }) }),
  z.object({ type: z.literal("task.create"), task: newTaskSchema }),
  z.object({ type: z.literal("task.update"), taskId: id, patch: taskPatchSchema }),
  z.object({ type: z.literal("task.delete"), taskId: id }),
  z.object({ type: z.literal("task.restore"), taskId: id }),
  setDelta(name).extend({ type: z.literal("task.assignees") }),
  setDelta(z.string().trim().min(1).max(40)).extend({ type: z.literal("task.tags") }),
  z.object({ type: z.literal("task.dependency.add"), taskId: id, dependsOn: id }),
  z.object({ type: z.literal("task.dependency.remove"), taskId: id, dependsOn: id }),
  z.object({ type: z.literal("comment.add"), comment: z.object({ id, taskId: id, content: z.string().trim().min(1).max(10_000) }) }),
  z.object({ type: z.literal("comment.delete"), taskId: id, commentId: id }),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandType = Command["type"];
export type NewTask = z.infer<typeof newTaskSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const commandRequestSchema = z.object({
  /** Client-generated id; lets the client match the resulting event to its optimistic update. */
  clientMutationId: z.string().min(1).max(64),
  command: commandSchema,
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;

export const createProjectSchema = z.object({
  name,
  description: z.string().max(5000).default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const sessionSchema = z.object({ name });

export const markReadSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(200).optional() });
