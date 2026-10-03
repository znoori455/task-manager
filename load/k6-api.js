// HTTP load test: concurrent users paging through a large project and writing
// commands to it. Run against the production build (docker compose up).
//
//   PROJECT_ID=<id> docker run --rm -i --network host -e PROJECT_ID grafana/k6 run - < load/k6-api.js
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const PROJECT = __ENV.PROJECT_ID;
const rateLimited = new Counter("rate_limited");

export const options = {
  scenarios: {
    // Clients opening the project: a full paginated load of every task. In
    // this design that happens once per session; afterwards clients only get deltas.
    project_opens: {
      executor: "constant-arrival-rate",
      exec: "read",
      rate: Number(__ENV.OPENS_PER_SEC || 2),
      timeUnit: "1s",
      duration: "45s",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    writers: {
      executor: "constant-arrival-rate",
      exec: "write",
      rate: Number(__ENV.WRITES_PER_SEC || 200),
      timeUnit: "1s",
      duration: "45s",
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    "http_req_duration{scenario:writers}": ["p(95)<250"],
    "http_req_duration{scenario:project_opens}": ["p(95)<500"],
    "http_req_failed{scenario:writers}": ["rate<0.01"],
  },
};

export function setup() {
  if (!PROJECT) throw new Error("set PROJECT_ID");
  const page = http.get(`${BASE}/api/projects/${PROJECT}/tasks?limit=500`).json();
  return { ids: page.tasks.map((t) => t.id) };
}

/** A client loading the whole project page by page (1000 tasks per page). */
export function read() {
  let cursor = null;
  let pages = 0;
  do {
    const res = http.get(`${BASE}/api/projects/${PROJECT}/tasks?limit=1000${cursor ? `&cursor=${cursor}` : ""}`, { tags: { name: "tasks page" } });
    check(res, { "page 200": (r) => r.status === 200 });
    cursor = res.json("nextCursor");
    pages++;
  } while (cursor && pages < 100);
}

/** Small, targeted writes: the kind of delta the system is designed around. */
export function write(data) {
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const user = `load-${__VU}`;
  const body = JSON.stringify({
    clientMutationId: `${user}-${__ITER}-${Date.now()}`,
    command: { type: "task.update", taskId: id, patch: { priority: ["low", "medium", "high", "urgent"][__ITER % 4] } },
  });
  const res = http.post(`${BASE}/api/projects/${PROJECT}/commands`, body, {
    headers: { "Content-Type": "application/json", Cookie: `tf_user=${user}` },
    tags: { name: "command" },
  });
  if (res.status === 429) rateLimited.add(1);
  check(res, { "command 200": (r) => r.status === 200 });
}
