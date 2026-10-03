import type { ProjectState } from "@/domain/apply";
import type { DomainEvent, EventBody } from "@/domain/events";
import type { Project, Task } from "@/domain/types";

export const project: Project = { id: "p1", name: "P", description: "", metadata: {}, version: 0, createdAt: "2026-01-01T00:00:00.000Z" };

export function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectId: "p1",
    title: id.toUpperCase(),
    status: "todo",
    assignedTo: [],
    configuration: { priority: "medium", description: "", tags: [], customFields: {} },
    dependencies: [],
    commentCount: 0,
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...over,
  };
}

export function state(...tasks: Task[]): ProjectState {
  return { project: { ...project }, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), comments: {} };
}

let seq = 0;
export function ev(body: EventBody, s = ++seq): DomainEvent {
  return { ...body, projectId: "p1", seq: s, actor: "alice", clientMutationId: null, timestamp: "2026-01-02T00:00:00.000Z" } as DomainEvent;
}
