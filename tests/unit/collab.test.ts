// Outgoing traffic from a shared description draft is batched, so fast typing
// can't trip the realtime service's per-connection rate limit.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const sent: { type: string; update?: string }[] = [];
const handlers = new Map<string, { onSync: (gen: string, state: string) => void }>();
vi.mock("@/client/realtime", () => ({
  sendDoc: (msg: { type: string; update?: string }) => sent.push(msg),
  registerDoc: (taskId: string, h: { onSync: (gen: string, state: string) => void }) => {
    handlers.set(taskId, h);
    return () => handlers.delete(taskId);
  },
}));

const { openDescriptionSession } = await import("@/client/collab");

afterEach(() => {
  sent.length = 0;
  vi.useRealTimers();
});

describe("description session batching", () => {
  it("merges a burst of keystrokes into a few messages, and loses no text", async () => {
    vi.useFakeTimers();
    const session = openDescriptionSession("t1", "", { name: "ann", color: "#f43f5e" }, () => {});
    const empty = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64");
    handlers.get("t1")!.onSync("gen1", empty);
    await session.ready;
    sent.length = 0;

    // 200 keystrokes over ~1s (5ms apart), each also moving the caret.
    for (let i = 0; i < 200; i++) {
      session.text.insert(session.text.length, "x");
      session.awareness.setLocalStateField("cursor", { at: i });
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(200);

    const updates = sent.filter((m) => m.type === "doc.update");
    const carets = sent.filter((m) => m.type === "doc.awareness");
    expect(updates.length).toBeLessThanOrEqual(21); // ~1 per 50ms
    expect(carets.length).toBeLessThanOrEqual(11); // ~1 per 100ms

    // Applying the batched updates elsewhere reproduces the full text.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Buffer.from(empty, "base64"));
    for (const u of updates) Y.applyUpdate(replica, Buffer.from(u.update!, "base64"));
    expect(replica.getText("description").toString()).toBe("x".repeat(200));
    session.destroy();
  });

  it("flushes pending edits when the session closes", async () => {
    vi.useFakeTimers();
    const session = openDescriptionSession("t2", "", { name: "ann", color: "#f43f5e" }, () => {});
    handlers.get("t2")!.onSync("gen1", Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64"));
    await session.ready;
    sent.length = 0;
    session.text.insert(0, "last words");
    session.destroy(); // before the batch timer fires
    expect(sent.map((m) => m.type)).toEqual(["doc.update", "doc.awareness", "doc.leave"]);
  });
});
