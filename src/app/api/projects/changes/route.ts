import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { projectsChangedSince } from "@/server/changes";
import { handler, json } from "@/server/http";

/** Projects updated or deleted after ?since=<ms>, for clients returning with a cached list. */
export const GET = handler(async (req: NextRequest) => {
  const since = Number(req.nextUrl.searchParams.get("since")) || 0;
  return json((await projectsChangedSince(since)) satisfies ApiResponse<"GET /api/projects/changes">);
});
