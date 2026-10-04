// Core domain model. Shared verbatim by the server (validation + persistence)
// and the client (optimistic updates), so both sides run identical logic.

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type CustomFieldValue = string | number | boolean;

export interface Project {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  /** Sequence number of the last event in this project's log. */
  version: number;
  createdAt: string;
  /** Time of the last event in this project. */
  updatedAt: string;
}

export interface TaskConfiguration {
  priority: Priority;
  description: string;
  tags: string[];
  customFields: Record<string, CustomFieldValue>;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  assignedTo: string[];
  configuration: TaskConfiguration;
  /** Ids of tasks that must be done before this one can be done. */
  dependencies: string[];
  commentCount: number;
  /** Seq of the last event that touched this task. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Soft delete keeps comments/dependencies intact so delete is undoable. */
  deletedAt: string | null;
}

export interface Comment {
  id: string;
  taskId: string;
  content: string;
  author: string;
  timestamp: string;
}
