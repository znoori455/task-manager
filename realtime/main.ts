// Entry point: `npm run realtime` (dev) / the `realtime` service in docker-compose.
import { startRealtimeServer } from "./server";

const port = Number(process.env.REALTIME_PORT ?? 3001);
const server = await startRealtimeServer({
  port,
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()) : "localhost",
});
console.log(`realtime: listening on :${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
