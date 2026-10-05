// The WebSocket service against a real Redis, with real ws clients.
import Redis from "ioredis";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage } from "@/contract/realtime";
import { startRealtimeServer } from "../../realtime/server";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const ORIGIN = "http://localhost:3000";
let server: Awaited<ReturnType<typeof startRealtimeServer>>;
let redis: Redis;

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  send: (msg: object) => void;
  next: <T extends ServerMessage["type"]>(type: T, where?: (m: Extract<ServerMessage, { type: T }>) => boolean) => Promise<Extract<ServerMessage, { type: T }>>;
  close: () => void;
}

function connect(name: string | null, origin = ORIGIN): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { origin, ...(name && { cookie: `tf_user=${encodeURIComponent(name)}` }) } });
    const messages: ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
      waiters.splice(0).forEach((w) => w());
    });
    const client: Client = {
      ws,
      messages,
      send: (msg) => ws.send(JSON.stringify(msg)),
      close: () => ws.close(),
      next: (type, where) =>
        new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), 3000);
          const check = () => {
            const i = messages.findIndex((m) => m.type === type && (!where || where(m as never)));
            if (i >= 0) {
              clearTimeout(timer);
              res(messages.splice(i, 1)[0] as never);
            } else waiters.push(check);
          };
          check();
        }),
    };
    ws.on("open", () => resolve(client));
    ws.on("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.on("error", reject);
  });
}

beforeAll(async () => {
  server = await startRealtimeServer({ port: 0, redisUrl: REDIS_URL, allowedOrigins: [ORIGIN] });
  redis = new Redis(REDIS_URL);
});

afterAll(async () => {
  await server.close();
  redis.disconnect();
});

describe("realtime service", () => {
  it("rejects connections without a session cookie or from other origins", async () => {
    await expect(connect(null)).rejects.toThrow("401");
    await expect(connect("mallory", "https://evil.example")).rejects.toThrow("403");
  });

  it("shares presence, selection, cursors and typing within a project", async () => {
    const projectId = `p-${nanoid(6)}`;
    const alice = await connect("alice");
    const bob = await connect("bob");
    const { connId: bobId } = await bob.next("welcome");

    alice.send({ type: "join", room: { projectId } });
    await alice.next("presence", (m) => m.peers.length === 1);
    bob.send({ type: "join", room: { projectId } });
    const both = await alice.next("presence", (m) => m.peers.length === 2);
    expect(both.peers.map((p) => p.name)).toEqual(["alice", "bob"]);

    // Selection: alice sees which task and field bob is editing.
    bob.send({ type: "select", taskId: "t1", field: "title" });
    const sel = await alice.next("presence", (m) => m.peers.some((p) => p.name === "bob" && p.taskId === "t1"));
    expect(sel.peers.find((p) => p.name === "bob")).toMatchObject({ connId: bobId, taskId: "t1", field: "title" });

    // Cursors are coalesced: many moves in one flush window arrive as the latest position only.
    for (let i = 1; i <= 10; i++) bob.send({ type: "cursor", cursor: { taskId: "t1", x: i / 10, y: 0.5 } });
    const cursors = await alice.next("cursors");
    expect(cursors.updates).toEqual([{ connId: bobId, name: "bob", cursor: { taskId: "t1", x: 1, y: 0.5 } }]);
    // Nobody gets their own cursor back.
    await new Promise((r) => setTimeout(r, 150));
    expect(bob.messages.some((m) => m.type === "cursors")).toBe(false);

    bob.send({ type: "typing", taskId: "t1", typing: true });
    expect(await alice.next("typing")).toMatchObject({ name: "bob", taskId: "t1", typing: true });

    // Leaving is instant (no waiting for a presence timeout).
    bob.close();
    const after = await alice.next("presence", (m) => m.peers.length === 1);
    expect(after.peers[0].name).toBe("alice");
    alice.close();
  });

  it("tells lobby clients who is in which project", async () => {
    const projectId = `p-${nanoid(6)}`;
    const watcher = await connect("watcher");
    watcher.send({ type: "join", room: "lobby" });
    await watcher.next("lobby");
    const carol = await connect("carol");
    carol.send({ type: "join", room: { projectId } });
    expect((await watcher.next("lobby", (m) => projectId in m.projects)).projects[projectId]).toEqual(["carol"]);
    carol.close();
    expect((await watcher.next("lobby", (m) => m.projects[projectId]?.length === 0)).projects[projectId]).toEqual([]);
    watcher.close();
  });

  it("forwards notifications published for a user to all of their connections", async () => {
    const name = `Dave-${nanoid(4)}`;
    const [tab1, tab2] = await Promise.all([connect(name), connect(name)]);
    await Promise.all([tab1.next("welcome"), tab2.next("welcome")]);
    await new Promise((r) => setTimeout(r, 50)); // subscription settles
    // Channels are keyed by the lowercased display name.
    await redis.publish(`notify:${name.toLowerCase()}`, JSON.stringify({ kind: "new", notification: { id: "n1", type: "mention" } }));
    expect((await tab1.next("notification")).notification).toMatchObject({ id: "n1" });
    expect((await tab2.next("notification")).notification).toMatchObject({ id: "n1" });
    // Read/clear in one tab is mirrored to the others.
    await redis.publish(`notify:${name.toLowerCase()}`, JSON.stringify({ kind: "sync", removed: ["n1"] }));
    expect(await tab1.next("notifications.sync")).toMatchObject({ removed: ["n1"] });
    expect(await tab2.next("notifications.sync")).toMatchObject({ removed: ["n1"] });
    tab1.close();
    tab2.close();
  });

  it("disconnects clients that flood it", async () => {
    const spammer = await connect("spammer");
    const closed = new Promise<number>((r) => spammer.ws.on("close", (code) => r(code)));
    for (let i = 0; i < 300; i++) spammer.send({ type: "cursor", cursor: null });
    expect(await closed).toBe(1008);
  });
});
