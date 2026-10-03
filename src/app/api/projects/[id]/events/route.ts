import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { handler, json } from "@/server/http";
import { listEvents } from "@/server/queries";

/** Activity feed, newest first. Paginate with ?before=<seq>. */
export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const before = Number(req.nextUrl.searchParams.get("before")) || null;
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 50));
  return json({ events: await listEvents(id, before, limit) } satisfies ApiResponse<"GET /api/projects/:id/events">);
});
