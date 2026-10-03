import type { NextRequest } from "next/server";
import { handler } from "@/server/http";
import { SSE_HEADERS, lobbyStream } from "@/server/sse";

/** Live project list: project created / renamed / deleted. */
export const GET = handler(async (req: NextRequest) => {
  return new Response(lobbyStream(req.signal), { headers: SSE_HEADERS });
});
