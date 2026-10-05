import type { NextRequest } from "next/server";
import { handler } from "@/server/http";
import { requireUser } from "@/server/session";
import { SSE_HEADERS, projectStream } from "@/server/sse";

/**
 * Live event stream for one project. Resumes after `Last-Event-ID` (sent
 * automatically by EventSource on reconnect) or `?since=`.
 */
export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  requireUser(req);
  const { id } = await params;
  const since = Number(req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("since") ?? 0) || 0;
  return new Response(projectStream(id, since, req.signal), { headers: SSE_HEADERS });
});
