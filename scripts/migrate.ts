import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://taskflow:taskflow@localhost:5432/taskflow", { max: 1 });
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
console.log("migrations applied");
await sql.end();
