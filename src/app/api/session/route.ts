import type { NextRequest } from "next/server";
import type { ApiResponse } from "@/contract/api";
import { sessionSchema } from "@/contract/schemas";
import { handler, json, parseBody } from "@/server/http";
import { SESSION_COOKIE, currentUser } from "@/server/session";

export const GET = handler(async (req: NextRequest) => {
  return json({ name: currentUser(req) } satisfies ApiResponse<"GET /api/session">);
});

export const POST = handler(async (req: NextRequest) => {
  const { name } = await parseBody(req, sessionSchema);
  const res = json({ name } satisfies ApiResponse<"POST /api/session">);
  res.headers.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(name)}; Path=/; SameSite=Lax; Max-Age=31536000`);
  return res;
});

/** Sign out (used to switch users). */
export const DELETE = handler(async () => {
  const res = json({ ok: true } satisfies ApiResponse<"DELETE /api/session">);
  res.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`);
  return res;
});
