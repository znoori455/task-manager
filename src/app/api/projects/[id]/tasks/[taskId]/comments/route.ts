import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { handler, json } from "@/server/http";
import { listComments } from "@/server/queries";

export const GET = handler(async (_req: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) => {
  const { id, taskId } = await params;
  return json({ comments: await listComments(id, taskId) } satisfies ApiResponse<"GET /api/projects/:id/tasks/:taskId/comments">);
});
