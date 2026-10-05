import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { handler, json } from "@/server/http";
import { removeNotifications } from "@/server/notifications";
import { requireUser } from "@/server/session";

/** Remove one notification (only the caller's own). */
export const DELETE = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = requireUser(req);
  const { id } = await params;
  return json((await removeNotifications(user, [id])) satisfies ApiResponse<"DELETE /api/notifications/:id">);
});
