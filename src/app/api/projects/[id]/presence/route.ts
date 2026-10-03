import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { presenceSchema } from "@/contract/schemas";
import { enforceRateLimit, handler, json, parseBody } from "@/server/http";
import { setPresence } from "@/server/redis";
import { requireUser } from "@/server/session";

/** Heartbeat: "I'm viewing this project (and maybe this task)". */
export const POST = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const name = requireUser(req);
  await enforceRateLimit(`presence:${name}`, 10, 2);
  const { id } = await params;
  const { taskId } = await parseBody(req, presenceSchema);
  await setPresence(id, { name, taskId, ts: Date.now() });
  return json({ ok: true } satisfies ApiResponse<"POST /api/projects/:id/presence">);
});
