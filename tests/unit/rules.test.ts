import { describe, expect, it } from "vitest";
import { blockingDependencies, canTransition, wouldCreateCycle } from "@/domain/rules";
import { task } from "./fixtures";

describe("status transitions", () => {
  it("follows the workflow", () => {
    expect(canTransition("todo", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "in_review")).toBe(true);
    expect(canTransition("in_review", "done")).toBe(true);
    expect(canTransition("done", "in_progress")).toBe(true);
  });
  it("rejects skipping straight from todo to done", () => {
    expect(canTransition("todo", "done")).toBe(false);
    expect(canTransition("todo", "in_review")).toBe(false);
  });
  it("treats staying put as allowed", () => {
    expect(canTransition("done", "done")).toBe(true);
  });
});

describe("dependency graph", () => {
  const graph = { a: ["b"], b: ["c"], c: [], d: [] };
  it("detects direct and transitive cycles", () => {
    expect(wouldCreateCycle(graph, "c", "a")).toBe(true); // c -> a -> b -> c
    expect(wouldCreateCycle(graph, "b", "a")).toBe(true);
    expect(wouldCreateCycle(graph, "a", "a")).toBe(true);
  });
  it("allows edges that keep the graph acyclic", () => {
    expect(wouldCreateCycle(graph, "a", "c")).toBe(false);
    expect(wouldCreateCycle(graph, "d", "a")).toBe(false);
  });
  it("terminates on a graph that already has a cycle", () => {
    expect(wouldCreateCycle({ x: ["y"], y: ["x"] }, "z", "x")).toBe(false);
  });
  it("ignores deleted dependencies when computing blockers", () => {
    const tasks = { a: task("a"), b: task("b", { deletedAt: "2026-01-01T00:00:00Z" }), c: task("c", { status: "done" }) };
    expect(blockingDependencies(task("x", { dependencies: ["a", "b", "c", "missing"] }), tasks).map((t) => t.id)).toEqual(["a"]);
  });
});
