import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { commandRequestSchema } from "@/contract/schemas";
import { executeCommand } from "@/server/commands";
import { enforceRateLimit, handler, json, parseBody } from "@/server/http";
import { requireUser } from "@/server/session";

/** The single write endpoint: every task/comment/project mutation is a command. */
export const POST = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = requireUser(req);
  // Burst of 40, sustained 20 writes/s per user.
  await enforceRateLimit(`cmd:${user}`, 40, 20);
  const { id } = await params;
  const body = await parseBody(req, commandRequestSchema);
  const result = await executeCommand(id, body, user);
  return json(result satisfies ApiResponse<"POST /api/projects/:id/commands">);
});
