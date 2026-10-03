import { nanoid } from "nanoid";
import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { createProjectSchema } from "@/contract/schemas";
import { createProject } from "@/server/commands";
import { enforceRateLimit, handler, json, parseBody } from "@/server/http";
import { listProjects } from "@/server/queries";
import { requireUser } from "@/server/session";

export const GET = handler(async () => {
  return json({ projects: await listProjects() } satisfies ApiResponse<"GET /api/projects">);
});

export const POST = handler(async (req: NextRequest) => {
  const user = requireUser(req);
  await enforceRateLimit(`projects:${user}`, 5, 0.5);
  const input = await parseBody(req, createProjectSchema);
  const project = await createProject(input, user, nanoid(12));
  return json({ project } satisfies ApiResponse<"POST /api/projects">, 201);
});
