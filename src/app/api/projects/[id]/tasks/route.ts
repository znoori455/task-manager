import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { parseFilter } from "@/contract/filters";
import { handler, json } from "@/server/http";
import { getTasksByIds, getProject, listTasks } from "@/server/queries";

/**
 * Task feed: most recently updated first, filterable (?status, ?assignee, ?q),
 * paginated with ?cursor. Or specific tasks with ?ids=a,b,c.
 */
export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const ids = sp.get("ids");
  if (ids) {
    const [tasks, project] = await Promise.all([getTasksByIds(id, ids.split(",").slice(0, 200)), getProject(id)]);
    return json({ tasks, nextCursor: null, version: project?.version ?? 0 } satisfies ApiResponse<"GET /api/projects/:id/tasks">);
  }
  const limit = Math.min(1000, Math.max(1, Number(sp.get("limit")) || 50));
  return json((await listTasks(id, { ...parseFilter(sp), cursor: sp.get("cursor"), limit })) satisfies ApiResponse<"GET /api/projects/:id/tasks">);
});
