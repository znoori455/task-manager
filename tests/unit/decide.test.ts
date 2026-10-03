import { describe, expect, it } from "vitest";
import { decide, DomainError, type DecideContext } from "@/domain/decide";
import { state, task } from "./fixtures";

const meta = { actor: "alice", now: "2026-01-02T00:00:00.000Z" };
const ctx = (...tasks: Parameters<typeof state>): DecideContext => {
  const s = state(...tasks);
  return { project: s.project, tasks: s.tasks };
};

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("decide", () => {
  it("creates a task with defaults", () => {
    const [e] = decide(ctx(), { type: "task.create", task: { id: "t1", title: "Hello" } }, meta);
    expect(e.type).toBe("task.created");
    if (e.type !== "task.created") return;
    expect(e.payload.task).toMatchObject({ id: "t1", status: "todo", projectId: "p1", configuration: { priority: "medium", tags: [] } });
  });

  it("rejects duplicate ids and unknown dependencies", () => {
    expectError(() => decide(ctx(task("t1")), { type: "task.create", task: { id: "t1", title: "x" } }, meta), "already_exists");
    expectError(() => decide(ctx(), { type: "task.create", task: { id: "t2", title: "x", dependencies: ["nope"] } }, meta), "not_found");
  });

  it("enforces the status workflow", () => {
    expectError(() => decide(ctx(task("t1")), { type: "task.update", taskId: "t1", patch: { status: "done" } }, meta), "invalid_transition");
  });

  it("blocks review/done until dependencies are done", () => {
    const s = ctx(task("dep"), task("t1", { status: "in_progress", dependencies: ["dep"] }));
    expectError(() => decide(s, { type: "task.update", taskId: "t1", patch: { status: "done" } }, meta), "blocked");
    const ok = ctx(task("dep", { status: "done" }), task("t1", { status: "in_progress", dependencies: ["dep"] }));
    expect(decide(ok, { type: "task.update", taskId: "t1", patch: { status: "done" } }, meta)).toHaveLength(1);
  });

  it("rejects dependency cycles", () => {
    const s = ctx(task("a", { dependencies: ["b"] }), task("b"));
    expectError(() => decide(s, { type: "task.dependency.add", taskId: "b", dependsOn: "a" }, meta), "cycle");
  });

  it("returns no events for no-ops", () => {
    const s = ctx(task("a", { configuration: { priority: "medium", description: "", tags: ["x"], customFields: {} } }));
    expect(decide(s, { type: "task.tags", taskId: "a", add: ["x"], remove: [] }, meta)).toEqual([]);
    expect(decide(s, { type: "task.update", taskId: "a", patch: { status: "todo" } }, meta)).toEqual([]);
  });

  it("only lets authors delete their comments", () => {
    const s = { ...ctx(task("a")), commentsById: { c1: { id: "c1", taskId: "a", content: "hi", author: "bob", timestamp: meta.now } } };
    expectError(() => decide(s, { type: "comment.delete", taskId: "a", commentId: "c1" }, meta), "forbidden");
    expect(decide(s, { type: "comment.delete", taskId: "a", commentId: "c1" }, { ...meta, actor: "bob" })).toHaveLength(1);
  });

  it("refuses to restore a task if that would close a cycle", () => {
    // a depends on deleted d; while d was deleted someone made d's dependency depend on a.
    const s = ctx(task("a", { dependencies: ["d"] }), task("d", { dependencies: ["b"], deletedAt: meta.now }), task("b", { dependencies: ["a"] }));
    expectError(() => decide(s, { type: "task.restore", taskId: "d" }, meta), "cycle");
  });
});
