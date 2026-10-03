// Seeds a small realistic demo project and a large one (10k tasks, ~5MB of
// task data) for exercising pagination, virtual scrolling and load tests.
//
//   npm run db:seed            # both projects
//   SEED_TASKS=50000 npm run db:seed
import { nanoid } from "nanoid";
import postgres from "postgres";
import { PRIORITIES, type TaskStatus } from "../src/domain/types";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://taskflow:taskflow@localhost:5432/taskflow", { max: 4 });
const LARGE = Number(process.env.SEED_TASKS ?? 10_000);
const PEOPLE = ["alice", "bob", "carol", "dave", "erin", "frank"];
const TAGS = ["frontend", "backend", "infra", "bug", "design", "docs", "perf", "security", "ux", "api"];
const VERBS = ["Implement", "Fix", "Refactor", "Document", "Test", "Review", "Design", "Optimize", "Migrate", "Audit"];
const NOUNS = ["login flow", "billing page", "search index", "event log", "SSE gateway", "rate limiter", "task board", "comment thread", "CI pipeline", "dashboard", "caching layer", "export job"];

const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const sample = <T>(xs: readonly T[], n: number) => [...xs].sort(() => Math.random() - 0.5).slice(0, n);

interface SeedTask {
  title: string;
  status: TaskStatus;
  deps?: number[];
  tags?: string[];
  assignees?: string[];
  description?: string;
  priority?: (typeof PRIORITIES)[number];
}

async function createProject(name: string, description: string, specs: SeedTask[]) {
  const projectId = nanoid(12);
  const now = new Date();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO projects (id, name, description, metadata, version, created_at) VALUES (${projectId}, ${name}, ${description}, ${tx.json({ seeded: true })}, 1, ${now})`;
    await tx`INSERT INTO events (project_id, seq, type, payload, actor, timestamp)
             VALUES (${projectId}, 1, 'project.created', ${tx.json({ project: { id: projectId, name, description, metadata: { seeded: true }, createdAt: now.toISOString() } })}, 'seed', ${now})`;

    const ids = specs.map(() => nanoid(12));
    const rows = specs.map((s, i) => {
      const t = new Date(now.getTime() - (specs.length - i) * 1000);
      return {
        id: ids[i],
        project_id: projectId,
        title: s.title,
        status: s.status,
        assigned_to: s.assignees ?? [],
        priority: s.priority ?? pick(PRIORITIES),
        description: s.description ?? "",
        tags: s.tags ?? [],
        custom_fields: {},
        dependencies: (s.deps ?? []).map((d) => ids[d]),
        comment_count: 0,
        version: 1,
        created_at: t,
        updated_at: t,
      };
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await tx`INSERT INTO tasks ${tx(rows.slice(i, i + 1000) as never)}`;
    }
  });
  return projectId;
}

function demoTasks(): SeedTask[] {
  return [
    { title: "Define launch scope", status: "done", tags: ["docs"], assignees: ["alice"], priority: "high", description: "Agree on what ships in v1." },
    { title: "Design onboarding screens", status: "done", deps: [0], tags: ["design", "ux"], assignees: ["carol"] },
    { title: "Build onboarding UI", status: "in_progress", deps: [1], tags: ["frontend"], assignees: ["bob"], priority: "high" },
    { title: "Signup API", status: "in_review", deps: [0], tags: ["backend", "api"], assignees: ["dave"] },
    { title: "Wire onboarding to signup API", status: "todo", deps: [2, 3], tags: ["frontend", "api"], priority: "urgent" },
    { title: "Load test signup", status: "todo", deps: [3], tags: ["perf"], assignees: ["erin"] },
    { title: "Security review", status: "todo", deps: [3], tags: ["security"], priority: "high" },
    { title: "Write launch blog post", status: "in_progress", tags: ["docs"], assignees: ["frank"], priority: "low" },
    { title: "Launch 🚀", status: "todo", deps: [4, 5, 6, 7], priority: "urgent", assignees: ["alice"] },
  ];
}

function largeTasks(n: number): SeedTask[] {
  const out: SeedTask[] = [];
  const filler = "Context, acceptance criteria and notes for this task. ".repeat(6);
  for (let i = 0; i < n; i++) {
    const status = pick<TaskStatus>(["todo", "todo", "in_progress", "in_review", "done", "done"]);
    // Dependencies only point at earlier tasks (keeps the graph acyclic); gated
    // statuses only depend on done tasks (keeps the seed consistent with the rules).
    const candidates = out.map((t, idx) => ({ t, idx })).slice(-50).filter(({ t }) => status === "todo" || status === "in_progress" || t.status === "done");
    const deps = Math.random() < 0.3 ? sample(candidates, 1 + Math.floor(Math.random() * 2)).map((c) => c.idx) : [];
    out.push({
      title: `${pick(VERBS)} ${pick(NOUNS)} #${i + 1}`,
      status,
      deps,
      tags: sample(TAGS, Math.floor(Math.random() * 3)),
      assignees: sample(PEOPLE, Math.floor(Math.random() * 3)),
      description: filler,
    });
  }
  return out;
}

const demo = await createProject("Product launch", "A small demo project with dependencies between tasks.", demoTasks());
console.log(`Seeded "Product launch" -> /projects/${demo}`);
const large = await createProject(`Large project (${LARGE.toLocaleString()} tasks)`, "Stress test for pagination, virtual scrolling and sync.", largeTasks(LARGE));
console.log(`Seeded large project with ${LARGE} tasks -> /projects/${large}`);
await sql.end();
