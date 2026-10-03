import { ZodError, type ZodType } from "zod";
import { DomainError, type DomainErrorCode } from "@/domain/decide";
import { rateLimit } from "./redis";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  already_exists: 409,
  invalid_transition: 422,
  blocked: 422,
  cycle: 422,
  forbidden: 403,
  invalid: 400,
};

export interface ApiError {
  error: { code: string; message: string; issues?: unknown };
}

/** Wraps a route handler, mapping thrown errors to a uniform JSON error shape. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, DOMAIN_STATUS[e.code]);
      if (e instanceof ZodError) return json({ error: { code: "invalid", message: "Invalid request", issues: e.issues } }, 400);
      if (e instanceof HttpError) return json({ error: { code: String(e.status), message: e.message } }, e.status, e.headers);
      console.error(e);
      return json({ error: { code: "internal", message: "Internal server error" } }, 500);
    }
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  return schema.parse(raw);
}

/** Token-bucket limit per key; throws 429 with Retry-After when exhausted. */
export async function enforceRateLimit(key: string, capacity: number, perSecond: number) {
  const { allowed, retryAfterMs } = await rateLimit(key, capacity, perSecond);
  if (!allowed) {
    throw new HttpError(429, "Too many requests", { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
  }
}
