// Shared drafts of task descriptions (Yjs), hosted by the realtime service.
//
//   rt:doc:<task>:updates  Redis list of base64 Yjs updates (merged periodically)
//   rt:doc:<task>:gen      id of this incarnation of the draft
//   rt:doc:<task>          pub/sub channel relaying updates and carets to every instance
//
// The draft is ephemeral: it expires DOC_TTL after the last participant leaves,
// and the next session starts from the saved description again. Clients save
// the text through the normal command pipeline; nothing here is durable.
import type Redis from "ioredis";
import { nanoid } from "nanoid";
import * as Y from "yjs";
import type { ServerMessage } from "../src/contract/realtime";

const MERGE_ABOVE = 100;

type DocMessage =
  | { kind: "update"; from: string; update: string }
  | { kind: "awareness"; from: string; update: string }
  | { kind: "peerLeft"; from: string; clientId: number };

interface Member {
  id: string;
  /** taskId -> Yjs client id */
  docs: Map<string, number>;
}

export interface DocRoomsDeps {
  redis: Redis;
  retain: (channel: string) => void;
  release: (channel: string) => void;
  send: (connId: string, msg: ServerMessage, droppable?: boolean) => void;
  ttlSeconds: number;
  isClosing: () => boolean;
}

const keys = {
  updates: (taskId: string) => `rt:doc:${taskId}:updates`,
  gen: (taskId: string) => `rt:doc:${taskId}:gen`,
  seedLock: (taskId: string) => `rt:doc:${taskId}:lock`,
  mergeLock: (taskId: string) => `rt:doc:${taskId}:merge`,
  channel: (taskId: string) => `rt:doc:${taskId}`,
};
export const DOC_CHANNEL_PREFIX = "rt:doc:";

const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createDocRooms(deps: DocRoomsDeps) {
  const { redis } = deps;
  /** taskId -> local connection ids in that doc room */
  const local = new Map<string, Set<string>>();

  async function read(taskId: string) {
    const [[, gen], [, updates]] = (await redis.multi().get(keys.gen(taskId)).lrange(keys.updates(taskId), 0, -1).exec()) as [[unknown, string | null], [unknown, string[]]];
    return { gen, updates };
  }

  /** Current draft, creating it from `seed` if none exists — exactly once across all joiners and instances. */
  async function getOrSeed(taskId: string, seed: string): Promise<{ gen: string; updates: string[] }> {
    let doc = await read(taskId);
    for (let attempt = 0; !doc.gen && attempt < 100; attempt++) {
      if (await redis.set(keys.seedLock(taskId), "1", "PX", 5000, "NX")) {
        try {
          doc = await read(taskId);
          if (!doc.gen) {
            const ydoc = new Y.Doc();
            ydoc.getText("description").insert(0, seed);
            const update = toB64(Y.encodeStateAsUpdate(ydoc));
            ydoc.destroy();
            const gen = nanoid(10);
            await redis
              .multi()
              .del(keys.updates(taskId))
              .rpush(keys.updates(taskId), update)
              .set(keys.gen(taskId), gen, "EX", deps.ttlSeconds)
              .expire(keys.updates(taskId), deps.ttlSeconds)
              .exec();
            doc = { gen, updates: [update] };
          }
        } finally {
          await redis.del(keys.seedLock(taskId));
        }
      } else {
        await sleep(20); // someone else is seeding; read what they create
        doc = await read(taskId);
      }
    }
    if (!doc.gen) throw new Error(`could not open draft for ${taskId}`);
    return { gen: doc.gen, updates: doc.updates };
  }

  async function sync(connId: string, taskId: string, seed: string) {
    const { gen, updates } = await getOrSeed(taskId, seed);
    const state = toB64(Y.mergeUpdates(updates.map(fromB64)));
    deps.send(connId, { type: "doc.sync", taskId, generation: gen, state });
  }

  async function join(member: Member, taskId: string, seed: string, clientId: number) {
    if (!member.docs.has(taskId)) {
      let set = local.get(taskId);
      if (!set) local.set(taskId, (set = new Set()));
      set.add(member.id);
      deps.retain(keys.channel(taskId));
    }
    member.docs.set(taskId, clientId);
    await sync(member.id, taskId, seed);
  }

  async function update(member: Member, taskId: string, generation: string, update: string) {
    if (!member.docs.has(taskId)) return;
    const current = await redis.get(keys.gen(taskId));
    if (current !== generation) {
      // The client is editing a draft that expired and was replaced: resync instead of merging into the new one.
      await sync(member.id, taskId, "");
      return;
    }
    const [, , , , [, length]] = (await redis
      .multi()
      .rpush(keys.updates(taskId), update)
      .expire(keys.updates(taskId), deps.ttlSeconds)
      .expire(keys.gen(taskId), deps.ttlSeconds)
      .publish(keys.channel(taskId), JSON.stringify({ kind: "update", from: member.id, update } satisfies DocMessage))
      .llen(keys.updates(taskId))
      .exec()) as [unknown, unknown, unknown, unknown, [unknown, number]];
    if (length > MERGE_ABOVE) void merge(taskId).catch(() => {});
  }

  /** Replace the first n stored updates with one merged update (later appends are untouched). */
  async function merge(taskId: string) {
    if (!(await redis.set(keys.mergeLock(taskId), "1", "PX", 5000, "NX"))) return;
    try {
      const updates = await redis.lrange(keys.updates(taskId), 0, -1);
      if (updates.length <= 1) return;
      const merged = toB64(Y.mergeUpdates(updates.map(fromB64)));
      await redis.multi().ltrim(keys.updates(taskId), updates.length, -1).lpush(keys.updates(taskId), merged).exec();
    } finally {
      await redis.del(keys.mergeLock(taskId));
    }
  }

  async function awareness(member: Member, taskId: string, update: string) {
    if (!member.docs.has(taskId)) return;
    await redis.publish(keys.channel(taskId), JSON.stringify({ kind: "awareness", from: member.id, update } satisfies DocMessage));
  }

  async function leave(member: Member, taskId: string) {
    const clientId = member.docs.get(taskId);
    if (clientId === undefined) return;
    member.docs.delete(taskId);
    const set = local.get(taskId);
    set?.delete(member.id);
    if (set && !set.size) local.delete(taskId);
    deps.release(keys.channel(taskId));
    if (!deps.isClosing()) {
      await redis.publish(keys.channel(taskId), JSON.stringify({ kind: "peerLeft", from: member.id, clientId } satisfies DocMessage));
    }
  }

  /** Fan a doc channel message out to local members. Updates are never dropped (the CRDT needs every one); carets may be. */
  function onChannelMessage(channel: string, raw: string) {
    const taskId = channel.slice(DOC_CHANNEL_PREFIX.length);
    const msg = JSON.parse(raw) as DocMessage;
    for (const connId of local.get(taskId) ?? []) {
      if (connId === msg.from) continue;
      if (msg.kind === "update") deps.send(connId, { type: "doc.update", taskId, update: msg.update });
      else if (msg.kind === "awareness") deps.send(connId, { type: "doc.awareness", taskId, update: msg.update }, true);
      else deps.send(connId, { type: "doc.peerLeft", taskId, clientId: msg.clientId });
    }
  }

  /** Keep drafts alive while anyone on this instance has them open. */
  async function heartbeat() {
    for (const taskId of local.keys()) {
      await redis.multi().expire(keys.updates(taskId), deps.ttlSeconds).expire(keys.gen(taskId), deps.ttlSeconds).exec();
    }
  }

  return { join, update, awareness, leave, onChannelMessage, heartbeat };
}
