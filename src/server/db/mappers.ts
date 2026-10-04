import type { Comment, Project, Task } from "@/domain/types";
import type { comments, projects, tasks } from "./schema";

type TaskRow = typeof tasks.$inferSelect;

export function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    status: r.status as Task["status"],
    assignedTo: r.assignedTo,
    configuration: {
      priority: r.priority as Task["configuration"]["priority"],
      description: r.description,
      tags: r.tags,
      customFields: r.customFields,
    },
    dependencies: r.dependencies,
    commentCount: r.commentCount,
    version: r.version,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    deletedAt: r.deletedAt ? new Date(r.deletedAt).toISOString() : null,
  };
}

export function fromTask(t: Task): TaskRow {
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    status: t.status,
    assignedTo: t.assignedTo,
    priority: t.configuration.priority,
    description: t.configuration.description,
    tags: t.configuration.tags,
    customFields: t.configuration.customFields,
    dependencies: t.dependencies,
    commentCount: t.commentCount,
    version: t.version,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    deletedAt: t.deletedAt,
  };
}

export function toProject(r: typeof projects.$inferSelect): Project {
  return { ...r, createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString() };
}

export function toComment(r: typeof comments.$inferSelect): Comment {
  return { ...r, timestamp: new Date(r.timestamp).toISOString() };
}
