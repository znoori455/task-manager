# Load test results

> Measured before the switch to infinite-scroll feeds, when page reads were
> ordered by `id`. The write path and SSE fan-out haven't changed. Pages are now
> ordered by `(updated_at, id)` on an equivalent keyset index.

Environment: MacBook (Apple Silicon, arm64), Docker Desktop. **One** Next.js
production process (`docker compose up`), Postgres 17 and Redis 7 in
containers on the same machine. Large project = 10,000 tasks (~5 MB in Postgres,
~7 MB as JSON).

## 1. SSE fan-out (`load/fanout.ts`)

200 SSE connections watching one project; 200 commands sent concurrently from
20 users.

```
npx tsx load/fanout.ts <projectId> 200 200
```

| metric | result |
| --- | --- |
| deliveries | 40,000 / 40,000 expected (every event reached every connection, in order) |
| commit → client latency | p50 **29 ms**, p95 **35 ms**, p99 45 ms, max 73 ms |
| write throughput (single project, single client) | ~104 commands/s |

## 2. HTTP mix (`load/k6-api.js`)

Mixed load for 45 s against the 10k-task project:

- **writers**: 200 commands/s (`task.update` on random tasks), each VU a distinct user
- **project_opens**: 2 full project loads/s (10 pages × 1,000 tasks ≈ 7 MB each)

```
docker run --rm -i -e PROJECT_ID=<id> -e BASE_URL=http://host.docker.internal:3000 grafana/k6 run - < load/k6-api.js
```

| scenario | p50 | p95 | errors |
| --- | --- | --- | --- |
| writers (200/s, all on one project) | 48 ms | **232 ms** | 0 / 8,955 |
| task pages (1,000 tasks each) | 16 ms | **244 ms** | 0 |

Throughput was ~218 req/s and ~14 MB/s. Both thresholds passed (p95 < 250 ms for writes, < 500 ms for pages).

### Where it breaks: re-downloading whole projects

The first version of the test had **50 clients each re-loading the whole
project every second**. That's about 50 × 7 MB/s, roughly 11 CPU-seconds of JSON
serialization per second. The single Node process saturated: p95 rose to 8–14 s,
and writes queued behind reads on the event loop. No requests failed, they were
only slow.

This is the case the architecture avoids. A client loads a project once (paged)
and after that receives only events of ~300 bytes each. To scale project opens,
run more stateless app replicas (Redis already fans events out across instances)
and route page reads to Postgres read replicas.

## 3. Rate limiting

80 concurrent writes from one user: **45 × 200, 35 × 429** (`Retry-After`
header set). The bucket allows a burst of 40 and refills at 20/s. The client
honours `Retry-After` and keeps the change pending, so nothing is lost.

## Database indexing

| query | index | plan |
| --- | --- | --- |
| task feed: `project_id = ? AND (updated_at, id) < cursor AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT n` | partial btree `(project_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL` | Index Scan, no sort; cost doesn't grow with page depth (keyset, not OFFSET) |
| project feed: `(updated_at, id) < cursor ORDER BY updated_at DESC, id DESC` | btree `(updated_at DESC, id DESC)` | Index Scan |
| catch-up fallback: `project_id = ? AND version > ?` | btree `(project_id, version)` | Index range scan; only used for writes the Redis index hasn't confirmed |
| search: `title ILIKE '%q%'` | GIN trigram (`pg_trgm`) on `title` | Bitmap index scan |
| replay: `events WHERE project_id = ? AND seq > ? ORDER BY seq` | PK `(project_id, seq)` | Index range scan |
| idempotency: `events WHERE project_id = ? AND client_mutation_id = ?` | btree `(project_id, client_mutation_id)` | Index Scan |
| comments for a task | btree `(task_id, timestamp)` | Index Scan, pre-sorted |
| board/status filters | partial btree `(project_id, status) WHERE deleted_at IS NULL` | |
| tag / assignee / reverse-dependency lookups | GIN on `tags`, `assigned_to`, `dependencies` | |
| cycle check | recursive CTE over PK lookups, visits only the reachable subgraph | |
