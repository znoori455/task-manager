// Deliberately minimal identity: users pick a display name, stored in a cookie.
// Real auth (OAuth/SSO) would slot in here without touching the sync design.
import type { NextRequest } from "next/server";
import { HttpError } from "./http";

export const SESSION_COOKIE = "tf_user";

export function currentUser(req: NextRequest): string | null {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  return raw ? decodeURIComponent(raw) : null;
}

export function requireUser(req: NextRequest): string {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "Pick a display name first");
  return user;
}
