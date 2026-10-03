import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { handler, json } from "@/server/http";
import { listTasks } from "@/server/queries";

export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(2000, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 500));
  return json((await listTasks(id, cursor, limit)) satisfies ApiResponse<"GET /api/projects/:id/tasks">);
});
