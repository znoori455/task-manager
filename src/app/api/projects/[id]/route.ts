import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { db, tables } from "@/server/db";
import { HttpError, handler, json } from "@/server/http";
import { getProject } from "@/server/queries";
import { channels, publish } from "@/server/redis";
import { requireUser } from "@/server/session";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const project = await getProject((await params).id);
  if (!project) throw new HttpError(404, "Project not found");
  return json({ project } satisfies ApiResponse<"GET /api/projects/:id">);
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  requireUser(req);
  const { id } = await params;
  await db.delete(tables.projects).where(eq(tables.projects.id, id));
  await publish(channels.lobby, { kind: "project.deleted", projectId: id }).catch(() => {});
  return json({ ok: true } satisfies ApiResponse<"DELETE /api/projects/:id">);
});
