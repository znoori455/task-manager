import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://taskflow:taskflow@localhost:5432/taskflow";

// Reuse one pool across Next.js hot reloads in development.
const g = globalThis as unknown as { __pg?: postgres.Sql };
export const pg = g.__pg ?? postgres(url, { max: Number(process.env.DB_POOL_SIZE ?? 20) });
if (process.env.NODE_ENV !== "production") g.__pg = pg;

export const db = drizzle(pg, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export * as tables from "./schema";
