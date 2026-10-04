import { nanoid } from "nanoid";
import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { createProjectSchema } from "@/contract/schemas";
import { createProject } from "@/server/commands";
import { enforceRateLimit, handler, json, parseBody } from "@/server/http";
import { listProjects } from "@/server/queries";
import { requireUser } from "@/server/session";

/** Most recently updated first; paginate with ?cursor=<nextCursor>. */
export const GET = handler(async (req: NextRequest) => {
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 30));
  return json((await listProjects(cursor, limit)) satisfies ApiResponse<"GET /api/projects">);
});

export const POST = handler(async (req: NextRequest) => {
  const user = requireUser(req);
  await enforceRateLimit(`projects:${user}`, 5, 0.5);
  const input = await parseBody(req, createProjectSchema);
  const project = await createProject(input, user, nanoid(12));
  return json({ project } satisfies ApiResponse<"POST /api/projects">, 201);
});
