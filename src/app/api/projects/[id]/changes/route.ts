import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { tasksChangedSince } from "@/server/changes";
import { handler, json } from "@/server/http";

/** Tasks changed after ?since=<seq>, for clients returning with a cached project. */
export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const since = Number(req.nextUrl.searchParams.get("since")) || 0;
  return json((await tasksChangedSince(id, since)) satisfies ApiResponse<"GET /api/projects/:id/changes">);
});
