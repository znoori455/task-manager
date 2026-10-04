// Server-Sent Events streams.
//
// Ordering: events are delivered strictly in seq order with no gaps. Live
// events from Redis may arrive out of order (concurrent publishers) or not at
// all (Redis hiccup), so out-of-order events are held briefly and any gap is
// filled from the cache/Postgres.
//
// Backpressure: each connection has a bounded queue. A client that can't keep
// up is disconnected rather than buffered without limit; on reconnect it
// resumes from Last-Event-ID, i.e. it falls back from push to pull.
import type { DomainEvent } from "@/domain/events";
import { eventsSince } from "./commands";
import { cachedEventsSince, channels, subscribe, type LobbyMessage, type ProjectMessage } from "./redis";

const HEARTBEAT_MS = 15_000;
const GAP_WAIT_MS = 300;
const MAX_REPLAY = 1000;
/** Max bytes queued for one client before we cut it loose. */
const MAX_QUEUED_BYTES = 1_000_000;

const encoder = new TextEncoder();

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

interface Conn {
  write(chunk: string): void;
  close(): void;
  closed: boolean;
}

function sseStream(signal: AbortSignal, start: (conn: Conn) => Promise<() => void> | (() => void)): ReadableStream<Uint8Array> {
  let cleanup: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const conn: Conn = { closed: false, write: () => {}, close: () => {} };

  const stop = () => {
    if (heartbeat) clearInterval(heartbeat);
    cleanup?.();
    cleanup = undefined;
  };

  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        conn.write = (chunk) => {
          if (conn.closed) return;
          if ((controller.desiredSize ?? 0) < -MAX_QUEUED_BYTES) {
            // Slow consumer: drop it. It will reconnect and replay from the log.
            conn.close();
            return;
          }
          controller.enqueue(encoder.encode(chunk));
        };
        conn.close = () => {
          if (conn.closed) return;
          conn.closed = true;
          stop();
          try {
            controller.close();
          } catch {}
        };
        signal.addEventListener("abort", () => conn.close());
        heartbeat = setInterval(() => conn.write(": ping\n\n"), HEARTBEAT_MS);
        conn.write("retry: 2000\n\n");
        cleanup = await start(conn);
        if (conn.closed) stop();
      },
      cancel() {
        conn.closed = true;
        stop();
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  );
}

export function projectStream(projectId: string, since: number, signal: AbortSignal) {
  return sseStream(signal, async (conn) => {
    let lastSent = since;
    const held = new Map<number, DomainEvent>();
    let gapTimer: ReturnType<typeof setTimeout> | null = null;
    let filling = false;

    const flush = () => {
      while (held.has(lastSent + 1)) {
        const e = held.get(lastSent + 1)!;
        held.delete(e.seq);
        lastSent = e.seq;
        conn.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      if (held.size && !gapTimer) gapTimer = setTimeout(fillGap, GAP_WAIT_MS);
    };
    const offer = (e: DomainEvent) => {
      if (e.seq <= lastSent) return;
      held.set(e.seq, e);
      flush();
    };
    const fillGap = async () => {
      gapTimer = null;
      if (filling || conn.closed) return;
      filling = true;
      try {
        const missed = (await cachedEventsSince(projectId, lastSent).catch(() => null)) ?? (await eventsSince(projectId, lastSent, MAX_REPLAY + 1));
        if (missed.length > MAX_REPLAY) {
          // Too far behind to replay efficiently: tell the client to reload a snapshot.
          conn.write(`event: resync\ndata: {}\n\n`);
          conn.close();
          return;
        }
        missed.forEach(offer);
      } finally {
        filling = false;
      }
    };

    // Subscribe before replaying so nothing committed in between is missed.
    const unsubscribe = subscribe(channels.project(projectId), (raw) => {
      const msg = JSON.parse(raw) as ProjectMessage;
      if (msg.kind === "event") offer(msg.event);
    });
    await fillGap();
    conn.write(`event: ready\ndata: ${JSON.stringify({ version: lastSent })}\n\n`);

    return () => {
      unsubscribe();
      if (gapTimer) clearTimeout(gapTimer);
    };
  });
}

export function lobbyStream(signal: AbortSignal) {
  return sseStream(signal, (conn) =>
    subscribe(channels.lobby, (raw) => {
      const msg = JSON.parse(raw) as LobbyMessage;
      conn.write(`data: ${JSON.stringify(msg)}\n\n`);
    }),
  );
}
