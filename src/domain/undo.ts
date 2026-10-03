// Undo is modelled as "send the inverse command", so history is never
// rewritten: other clients just see one more ordinary event.
import type { Command, TaskPatch } from "@/contract/schemas";
import type { ProjectState } from "./apply";

/** The command that reverses `cmd`, computed against the state before `cmd` ran. Null if not undoable. */
export function invert(cmd: Command, before: ProjectState): Command | null {
  switch (cmd.type) {
    case "task.create":
      return { type: "task.delete", taskId: cmd.task.id };
    case "task.delete":
      return { type: "task.restore", taskId: cmd.taskId };
    case "task.restore":
      return { type: "task.delete", taskId: cmd.taskId };
    case "task.update": {
      const task = before.tasks[cmd.taskId];
      if (!task) return null;
      const patch: TaskPatch = {};
      const p = cmd.patch;
      if (p.title !== undefined) patch.title = task.title;
      if (p.status !== undefined) patch.status = task.status;
      if (p.priority !== undefined) patch.priority = task.configuration.priority;
      if (p.description !== undefined) patch.description = task.configuration.description;
      if (p.customFields) {
        patch.customFields = {};
        for (const k of Object.keys(p.customFields)) patch.customFields[k] = task.configuration.customFields[k] ?? null;
      }
      return { type: "task.update", taskId: cmd.taskId, patch };
    }
    case "task.assignees":
    case "task.tags": {
      const task = before.tasks[cmd.taskId];
      if (!task) return null;
      const current = cmd.type === "task.tags" ? task.configuration.tags : task.assignedTo;
      return {
        type: cmd.type,
        taskId: cmd.taskId,
        add: cmd.remove.filter((x) => current.includes(x)),
        remove: cmd.add.filter((x) => !current.includes(x)),
      };
    }
    case "task.dependency.add":
      return { type: "task.dependency.remove", taskId: cmd.taskId, dependsOn: cmd.dependsOn };
    case "task.dependency.remove":
      return { type: "task.dependency.add", taskId: cmd.taskId, dependsOn: cmd.dependsOn };
    case "project.update": {
      const patch: Extract<Command, { type: "project.update" }>["patch"] = {};
      if (cmd.patch.name !== undefined) patch.name = before.project.name;
      if (cmd.patch.description !== undefined) patch.description = before.project.description;
      if (cmd.patch.metadata !== undefined) patch.metadata = before.project.metadata;
      return { type: "project.update", patch };
    }
    case "comment.add":
    case "comment.delete":
      return null;
  }
}
