import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { markReadSchema } from "@/contract/schemas";
import { handler, json, parseBody } from "@/server/http";
import { markRead } from "@/server/notifications";
import { requireUser } from "@/server/session";

export const POST = handler(async (req: NextRequest) => {
  const user = requireUser(req);
  const { ids } = await parseBody(req, markReadSchema);
  return json((await markRead(user, ids)) satisfies ApiResponse<"POST /api/notifications/read">);
});
