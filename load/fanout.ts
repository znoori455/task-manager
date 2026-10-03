export {};
// SSE fan-out test: opens N stream connections to one project, fires M
// commands, and measures commit -> delivery latency on every connection.
//
//   npx tsx load/fanout.ts <projectId> [connections=200] [commands=200]
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const [projectId, connsArg = "200", cmdsArg = "200"] = process.argv.slice(2);
if (!projectId) throw new Error("usage: tsx load/fanout.ts <projectId> [connections] [commands]");
const CONNS = Number(connsArg);
const CMDS = Number(cmdsArg);

const latencies: number[] = [];
const received = new Map<number, number>(); // seq -> connections that got it
let ready = 0;

async function listen(i: number, since: number, abort: AbortSignal) {
  const res = await fetch(`${BASE}/api/projects/${projectId}/stream?since=${since}`, { headers: { Cookie: `tf_user=listener-${i}` }, signal: abort });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
    if (done) return;
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.startsWith("event: ready")) ready++;
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!data || frame.includes("event: ")) continue;
      const e = JSON.parse(data.slice(6));
      latencies.push(Date.now() - new Date(e.timestamp).getTime());
      received.set(e.seq, (received.get(e.seq) ?? 0) + 1);
    }
  }
}

const { project } = await (await fetch(`${BASE}/api/projects/${projectId}`)).json();
const { tasks } = await (await fetch(`${BASE}/api/projects/${projectId}/tasks?limit=200`)).json();
const abort = new AbortController();
for (let i = 0; i < CONNS; i++) void listen(i, project.version, abort.signal);
while (ready < CONNS) await new Promise((r) => setTimeout(r, 50));
console.log(`${CONNS} SSE connections ready`);

const t0 = Date.now();
await Promise.all(
  Array.from({ length: CMDS }, async (_, i) => {
    const user = `writer-${i % 20}`;
    await fetch(`${BASE}/api/projects/${projectId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `tf_user=${user}` },
      body: JSON.stringify({ clientMutationId: `fanout-${t0}-${i}`, command: { type: "task.update", taskId: tasks[i % tasks.length].id, patch: { title: `fanout ${i}` } } }),
    });
  }),
);
const writeMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 2000));
abort.abort();

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
const complete = [...received.values()].filter((n) => n === CONNS).length;
console.log(`commands: ${CMDS} in ${writeMs}ms (${Math.round((CMDS / writeMs) * 1000)}/s)`);
console.log(`deliveries: ${latencies.length} (expected ${CMDS * CONNS}); events delivered to every connection: ${complete}/${received.size}`);
console.log(`commit->client latency ms: p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${latencies.at(-1)}`);
process.exit(0);
