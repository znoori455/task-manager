// Typed fetch wrappers. Paths and payloads are checked against the `Api`
// contract shared with the route handlers.
import type { Api } from "@/contract/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}

type Method<K> = K extends `${infer M} ${string}` ? M : never;
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined;

export async function call<K extends keyof Api>(
  route: K,
  opts: { params?: Record<string, string>; query?: Record<string, string | number | null | undefined>; body?: Body<K> } = {},
): Promise<Api[K]["res"]> {
  const [method, template] = (route as string).split(" ") as [Method<K>, string];
  let path = template.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(opts.params?.[k] ?? ""));
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== null && v !== undefined) qs.set(k, String(v));
  if ([...qs].length) path += `?${qs}`;

  const res = await fetch(path, {
    method,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    const retryAfter = Number(res.headers.get("Retry-After") ?? 0) * 1000;
    throw new ApiError(res.status, err?.error?.code ?? String(res.status), err?.error?.message ?? res.statusText, retryAfter);
  }
  return res.json();
}
