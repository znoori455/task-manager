import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { parseFilter } from "@/contract/filters";
import { handler, json } from "@/server/http";
import { countTasks } from "@/server/queries";

export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return json((await countTasks(id, parseFilter(req.nextUrl.searchParams))) satisfies ApiResponse<"GET /api/projects/:id/tasks/counts">);
});
