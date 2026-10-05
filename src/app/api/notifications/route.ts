import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { handler, json } from "@/server/http";
import { listNotifications, removeNotifications } from "@/server/notifications";
import { requireUser } from "@/server/session";

export const GET = handler(async (req: NextRequest) => {
  const user = requireUser(req);
  const before = req.nextUrl.searchParams.get("before");
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 30));
  return json((await listNotifications(user, before && !Number.isNaN(Date.parse(before)) ? before : null, limit)) satisfies ApiResponse<"GET /api/notifications">);
});

/** Clear all of your notifications. */
export const DELETE = handler(async (req: NextRequest) => {
  const user = requireUser(req);
  return json((await removeNotifications(user)) satisfies ApiResponse<"DELETE /api/notifications">);
});
