import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { createReadStream, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHmac } from "crypto";
import { config } from "./config.js";
import { api } from "./routes/api.js";
import { pages } from "./routes/pages.js";
import { createRedisConnection, createQueues, type Queues } from "./queue/index.js";
import { getStorage, type StorageAdapter } from "./services/storage.js";
import { warmFolderCache } from "./services/heygen.js";

type AppEnv = {
  Variables: {
    queues: Queues;
    storage: StorageAdapter;
  };
};

export function createApp(queues: Queues, storage: StorageAdapter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Make queues available to routes
  app.use("*", async (c, next) => {
    c.set("queues", queues);
    c.set("storage", storage);
    await next();
  });

  // ── Middleware ───────────────────────────────────────────────
  app.use("*", logger());
  // Absoluter Pfad statt "./public": im App-Bundle ist das cwd nicht das
  // Projektverzeichnis. Nur einhängen, wenn es die Dateien wirklich gibt.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  if (existsSync(publicDir)) {
    app.use("/static/*", serveStatic({ root: publicDir }));
  }

  // ── Local storage file serving (signed URLs) ────────────────
  if (config.storage.provider === "local") {
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
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      uptime: process.uptime(),
      mode: config.mode,
      storage: config.storage.provider,
    })
  );

  return app;
}

export interface WebHandle {
  port: number;
  queues: Queues;
  close(): Promise<void>;
}

/**
 * Startet den HTTP-Server. `port: 0` überlässt die Wahl dem Betriebssystem —
 * die Desktop-App nutzt das, um Konflikte mit einer laufenden Server-Instanz
 * zu vermeiden.
 */
export function startWeb(port = config.port): Promise<WebHandle> {
  const redis = createRedisConnection();
  const queues = createQueues(redis);
  const storage = getStorage(); // validates config on startup
  const app = createApp(queues, storage);

  warmFolderCache(); // Ordnerbaum im Hintergrund laden

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port }, (info) => {
      resolve({
        port: info.port,
        queues,
        close: async () => {
          await new Promise<void>((done) => server.close(() => done()));
          await Promise.all(Object.values(queues).map((q) => q.close()));
          redis?.disconnect();
        },
      });
    });
  });
}
