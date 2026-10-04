import { describe, expect, it } from "vitest";
import { applyEvents } from "@/domain/apply";
import type { EventBody } from "@/domain/events";
import { notificationsFor } from "@/domain/notifications";
import { ev, state, task } from "./fixtures";

function run(bodies: EventBody[], actor = "alice", base = state(task("t", { title: "Ship it", assignedTo: ["Bob", "carol"] }))) {
  const events = bodies.map((b, i) => ({ ...ev(b, 100 + i), actor }));
  return notificationsFor(events, base, applyEvents(base, events)).map((n) => `${n.recipient}:${n.type}`);
}

const comment = (content: string): EventBody => ({
  type: "comment.added",
  payload: { comment: { id: "c", taskId: "t", content, author: "alice", timestamp: "2026-01-01T00:00:00Z" } },
});

describe("notificationsFor", () => {
  it("notifies mentioned users, and assignees who weren't mentioned", () => {
    expect(run([comment("@dave @bob take a look")])).toEqual(["dave:mention", "bob:mention", "carol:comment"]);
  });

  it("never notifies the actor about their own change", () => {
    expect(run([comment("note to self @alice")])).toEqual(["bob:comment", "carol:comment"]);
    expect(run([comment("hi")], "bob")).toEqual(["carol:comment"]);
  });

  it("notifies newly assigned users", () => {
    expect(run([{ type: "task.assignees.changed", payload: { taskId: "t", add: ["erin", "alice"], remove: [] } }])).toEqual(["erin:assigned"]);
    expect(run([{ type: "task.created", payload: { task: task("n", { assignedTo: ["frank"] }) } }])).toEqual(["frank:assigned"]);
  });

  it("notifies assignees when status changes, not on other edits", () => {
    expect(run([{ type: "task.updated", payload: { taskId: "t", patch: { status: "in_progress" } } }])).toEqual(["bob:status", "carol:status"]);
    expect(run([{ type: "task.updated", payload: { taskId: "t", patch: { title: "renamed" } } }])).toEqual([]);
  });
});
