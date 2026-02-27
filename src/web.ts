import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.js";
import { api } from "./routes/api.js";
import { pages } from "./routes/pages.js";
import { createRedisConnection, createQueues, type Queues } from "./queue/index.js";
import { getStorage, type StorageAdapter } from "./services/storage.js";

type AppEnv = {
  Variables: {
    queues: Queues;
    storage: StorageAdapter;
  };
};

const app = new Hono<AppEnv>();

// ── Init ────────────────────────────────────────────────────
const redis = createRedisConnection();
const queues = createQueues(redis);
const storage = getStorage(); // validates config on startup

// Make queues available to routes
app.use("*", async (c, next) => {
  c.set("queues", queues);
  c.set("storage", storage);
  await next();
});

// ── Middleware ───────────────────────────────────────────────
app.use("*", logger());
app.use("/static/*", serveStatic({ root: "./public" }));

// ── Local storage file serving (signed URLs) ────────────────
if (config.storage.provider === "local") {
  const { createReadStream, existsSync } = await import("fs");
  const { join } = await import("path");
  const { createHmac } = await import("crypto");

  app.get("/files/*", (c) => {
    const key = c.req.path.replace("/files/", "");
    const expires = Number(c.req.query("expires") || 0);
    const sig = c.req.query("sig") || "";

    // Validate signature
    const payload = `${key}:${expires}`;
    const expected = createHmac("sha256", config.session.secret)
      .update(payload)
      .digest("hex")
      .slice(0, 16);

    if (sig !== expected || Date.now() > expires) {
      return c.text("Forbidden", 403);
    }

    const filePath = join(config.storage.local.path, key);
    if (!existsSync(filePath)) return c.text("Not found", 404);

    const stream = createReadStream(filePath);
    return new Response(stream as any, {
      headers: { "Content-Disposition": `attachment; filename="${key.split("/").pop()}"` },
    });
  });
}

// ── Routes ──────────────────────────────────────────────────
app.route("/api", api);
app.route("/", pages);

// ── Health ──────────────────────────────────────────────────
app.get("/health", (c) => c.json({
  status: "ok",
  uptime: process.uptime(),
  storage: config.storage.provider,
}));

// ── Start ───────────────────────────────────────────────────
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  HeyGen Proofreader (web)                ║
  ║  http://localhost:${info.port}                  ║
  ║  Storage: ${config.storage.provider.padEnd(28)}  ║
  ║  ${config.isDev ? "🔧 Development" : "🚀 Production"}                       ║
  ╚══════════════════════════════════════════╝
  `);
});
