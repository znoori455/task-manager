import { describe, expect, it } from "vitest";
import { applyEvents } from "@/domain/apply";
import { decide } from "@/domain/decide";
import { invert } from "@/domain/undo";
import type { Command } from "@/contract/schemas";
import { mentions } from "@/client/store";
import { ev, state, task } from "./fixtures";

describe("applyEvents", () => {
  it("merges concurrent edits to different fields of the same task", () => {
    const s0 = state(task("a"));
    const events = [
      ev({ type: "task.updated", payload: { taskId: "a", patch: { title: "From Alice" } } }, 1),
      ev({ type: "task.updated", payload: { taskId: "a", patch: { priority: "urgent" } } }, 2),
    ];
    const s1 = applyEvents(s0, events);
    expect(s1.tasks.a.title).toBe("From Alice");
    expect(s1.tasks.a.configuration.priority).toBe("urgent");
    expect(s1.project.version).toBe(2);
  });

  it("merges concurrent tag edits as set operations", () => {
    const s0 = state(task("a", { configuration: { priority: "low", description: "", tags: ["x"], customFields: {} } }));
    const s1 = applyEvents(s0, [
      ev({ type: "task.tags.changed", payload: { taskId: "a", add: ["y"], remove: [] } }, 1),
      ev({ type: "task.tags.changed", payload: { taskId: "a", add: ["z"], remove: ["x"] } }, 2),
    ]);
    expect(s1.tasks.a.configuration.tags).toEqual(["y", "z"]);
  });

  it("skips events already reflected in a task snapshot (per-task version)", () => {
    // Page loaded at version 5 already contains the update at seq 4.
    const s0 = state(task("a", { title: "new", version: 5 }));
    const s1 = applyEvents(s0, [ev({ type: "task.updated", payload: { taskId: "a", patch: { title: "old" } } }, 4)]);
    expect(s1.tasks.a.title).toBe("new");
  });

  it("is deterministic: two replicas applying the same log converge", () => {
    const log = [
      ev({ type: "task.created", payload: { task: task("b") } }, 1),
      ev({ type: "task.updated", payload: { taskId: "b", patch: { customFields: { points: 3, team: "core" } } } }, 2),
      ev({ type: "task.updated", payload: { taskId: "b", patch: { customFields: { team: null } } } }, 3),
      ev({ type: "task.dependency.added", payload: { taskId: "b", dependsOn: "a" } }, 4),
    ];
    const r1 = applyEvents(state(task("a")), log);
    const r2 = applyEvents(applyEvents(state(task("a")), log.slice(0, 2)), log.slice(2));
    expect(r1.tasks).toEqual(r2.tasks);
    expect(r1.tasks.b.configuration.customFields).toEqual({ points: 3 });
  });

  it("does not mutate the input state", () => {
    const s0 = state(task("a"));
    const snapshot = JSON.stringify(s0);
    applyEvents(s0, [ev({ type: "task.deleted", payload: { taskId: "a" } }, 1)]);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});

describe("undo", () => {
  const meta = { actor: "alice", now: "2026-01-02T00:00:00.000Z" };
  const run = (s: ReturnType<typeof state>, cmd: Command, seq: number) =>
    applyEvents(s, decide(s, cmd, meta).map((b, i) => ev(b, seq + i)));

  it.each<Command>([
    { type: "task.update", taskId: "a", patch: { title: "renamed", priority: "urgent", customFields: { k: 1 } } },
    { type: "task.tags", taskId: "a", add: ["new"], remove: ["old"] },
    { type: "task.assignees", taskId: "a", add: ["bob"], remove: [] },
    { type: "task.delete", taskId: "a" },
    { type: "task.dependency.add", taskId: "a", dependsOn: "b" },
  ])("inverse of $type restores the original state", (cmd) => {
    const s0 = state(task("a", { configuration: { priority: "low", description: "", tags: ["old"], customFields: {} } }), task("b"));
    const inverse = invert(cmd, s0)!;
    const s2 = run(run(s0, cmd, 1), inverse, 10);
    const strip = ({ version, updatedAt, ...rest }: typeof s0.tasks.a) => (void version, void updatedAt, rest);
    expect(strip(s2.tasks.a)).toEqual(strip(s0.tasks.a));
  });
});

describe("mentions", () => {
  it("matches @name as a whole word, case-insensitively", () => {
    expect(mentions("hey @Alice look", "alice")).toBe(true);
    expect(mentions("@alice", "alice")).toBe(true);
    expect(mentions("@alicea", "alice")).toBe(false);
    expect(mentions("email@alice.com", "alice")).toBe(false);
  });
});
