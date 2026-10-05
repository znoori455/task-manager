// Redis is used for three things: cross-instance pub/sub fan-out, a cache of
// each project's most recent events (fast reconnect replay), and rate limiting.
// Postgres stays the source of truth; losing Redis only degrades latency.
import Redis from "ioredis";
import type { NotificationView } from "@/contract/realtime";
import type { DomainEvent } from "@/domain/events";
import type { Project } from "@/domain/types";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export type ProjectMessage = { kind: "event"; event: DomainEvent };
export type LobbyMessage = { kind: "project.upserted"; project: Project } | { kind: "project.deleted"; projectId: string };

type Listener = (message: string) => void;

interface RedisGlobals {
  client: Redis;
  subscriber: Redis;
  listeners: Map<string, Set<Listener>>;
}

function init(): RedisGlobals {
  const client = new Redis(url, { maxRetriesPerRequest: 2 });
  // A connection in subscribe mode can't issue other commands, so it gets its own.
  const subscriber = new Redis(url);
  const listeners = new Map<string, Set<Listener>>();
  subscriber.on("message", (channel: string, message: string) => {
    for (const l of listeners.get(channel) ?? []) l(message);
  });
  for (const c of [client, subscriber]) c.on("error", (e: Error) => console.error("[redis]", e.message));
  return { client, subscriber, listeners };
}

const g = globalThis as unknown as { __redis?: RedisGlobals };
const r = (g.__redis ??= init());

export const redis = r.client;

export const channels = {
  project: (id: string) => `project:${id}`,
  lobby: "projects",
  /** Per-user notifications, forwarded to the user's WebSocket connections by the realtime service. */
  notify: (userKey: string) => `notify:${userKey}`,
};

/**
 * One Redis subscription per channel per process, fanned out in memory to
 * every SSE connection on this instance.
 */
export function subscribe(channel: string, listener: Listener): () => void {
  let set = r.listeners.get(channel);
  if (!set) {
    set = new Set();
    r.listeners.set(channel, set);
    void r.subscriber.subscribe(channel);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && r.listeners.get(channel) === set) {
      r.listeners.delete(channel);
      void r.subscriber.unsubscribe(channel);
    }
  };
}

export async function publish(channel: string, message: ProjectMessage | LobbyMessage | NotificationView) {
  await redis.publish(channel, JSON.stringify(message));
}

// ---------- Recent-events cache ----------

const RECENT_EVENTS = 500;
const recentKey = (projectId: string) => `events:${projectId}`;

export async function cacheEvents(projectId: string, events: DomainEvent[]) {
  if (!events.length) return;
  await redis
    .multi()
    .rpush(recentKey(projectId), ...events.map((e) => JSON.stringify(e)))
    .ltrim(recentKey(projectId), -RECENT_EVENTS, -1)
    .expire(recentKey(projectId), 60 * 60 * 24)
    .exec();
}

/** Events after `since` if the cache holds a contiguous run starting at since+1; otherwise null. */
export async function cachedEventsSince(projectId: string, since: number): Promise<DomainEvent[] | null> {
  const raw = await redis.lrange(recentKey(projectId), 0, -1);
  const events = raw.map((x) => JSON.parse(x) as DomainEvent).sort((a, b) => a.seq - b.seq);
  if (!events.length || events[0].seq > since + 1) return null;
  const out = events.filter((e) => e.seq > since);
  for (let i = 0; i < out.length; i++) if (out[i].seq !== since + 1 + i) return null;
  return out;
}

// ---------- Rate limiting (token bucket, atomic in Lua) ----------

const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + (now - ts) * refill_per_ms)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / refill_per_ms)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_ms) + 1000)
return {allowed, retry}
`;

export async function rateLimit(key: string, capacity: number, perSecond: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
  try {
    const [allowed, retry] = (await redis.eval(TOKEN_BUCKET, 1, `rl:${key}`, capacity, perSecond / 1000, Date.now())) as [number, number];
    return { allowed: allowed === 1, retryAfterMs: retry };
  } catch {
    // Fail open: an unavailable limiter shouldn't take writes down with it.
    return { allowed: true, retryAfterMs: 0 };
  }
}
