import "dotenv/config";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { randomBytes } from "crypto";

const storageProvider = z.enum(["r2", "dropbox", "google_drive", "onedrive", "local"]);

/**
 * APP_MODE wählt das Infrastruktur-Profil:
 *   server  → MySQL + Redis/BullMQ (Deployment auf dem vServer)
 *   desktop → SQLite + In-Process-Queue (Standalone Mac-App, kein Docker)
 * DB_DRIVER/QUEUE_DRIVER können das einzeln überschreiben.
 */
const envSchema = z.object({
  APP_MODE: z.enum(["server", "desktop"]).default("server"),
  DB_DRIVER: z.enum(["mysql", "sqlite"]).optional(),
  QUEUE_DRIVER: z.enum(["bullmq", "local"]).optional(),

  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production"]).default("development"),

  // Ablageort für SQLite-DB, Storage und Session-Key im Desktop-Modus
  APP_DATA_DIR: z.string().default(""),
  SQLITE_PATH: z.string().default(""),

  // Im Desktop-Modus nicht erforderlich (siehe requireForServer unten)
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default(""),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default(""),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().default(""),

  HEYGEN_API_KEY: z.string().default(""),
  HEYGEN_MAX_CONCURRENCY: z.coerce.number().default(5),
  HEYGEN_REQUESTS_PER_MINUTE: z.coerce.number().default(30),

  // Storage
  STORAGE_PROVIDER: storageProvider.default("local"),

  // Local
  LOCAL_STORAGE_PATH: z.string().default("./storage"),
  LOCAL_STORAGE_BASE_URL: z.string().default("http://localhost:3000/files"),

  // R2
  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET_NAME: z.string().default("heygen-proofreader"),

  // Dropbox
  DROPBOX_ACCESS_TOKEN: z.string().default(""),
  DROPBOX_ROOT_FOLDER: z.string().default("/heygen-proofreader"),

  // Google Drive
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(""),
  GOOGLE_DRIVE_FOLDER_ID: z.string().default(""),

  // OneDrive
  ONEDRIVE_CLIENT_ID: z.string().default(""),
  ONEDRIVE_CLIENT_SECRET: z.string().default(""),
  ONEDRIVE_TENANT_ID: z.string().default(""),
  ONEDRIVE_DRIVE_ID: z.string().default(""),
  ONEDRIVE_ROOT_FOLDER: z.string().default("/heygen-proofreader"),

  SESSION_SECRET: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  // Werfen statt process.exit: die Desktop-App kann den Fehler abfangen und
  // anzeigen — ein exit() beendet den Prozess wortlos und ohne Fenster.
  throw new Error(
    `Ungültige Umgebungsvariablen: ${Object.keys(parsed.error.flatten().fieldErrors).join(", ")}`
  );
}

const env = parsed.data;

const isDesktop = env.APP_MODE === "desktop";
const dbDriver = env.DB_DRIVER ?? (isDesktop ? "sqlite" : "mysql");
const queueDriver = env.QUEUE_DRIVER ?? (isDesktop ? "local" : "bullmq");

// ── Datenverzeichnis (Desktop) ───────────────────────────────

const dataDir = resolve(env.APP_DATA_DIR || (isDesktop ? "./data" : "."));
if (isDesktop) mkdirSync(dataDir, { recursive: true });

const sqlitePath = resolve(env.SQLITE_PATH || join(dataDir, "heygen.db"));

/**
 * Session-Secret signiert lokale Download-URLs. Im Server-Modus ist es
 * Pflicht; im Desktop-Modus wird einmalig eins erzeugt und im Datenverzeichnis
 * abgelegt, damit ausgestellte Links einen Neustart überleben.
 */
function resolveSessionSecret(): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (!isDesktop) return "";

  const keyFile = join(dataDir, "session.key");
  if (existsSync(keyFile)) {
    const existing = readFileSync(keyFile, "utf-8").trim();
    if (existing.length >= 16) return existing;
  }
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, secret, { mode: 0o600 });
  return secret;
}

const sessionSecret = resolveSessionSecret();

// ── Modusabhängige Pflichtfelder ─────────────────────────────

const missing: string[] = [];
if (dbDriver === "mysql") {
  if (!env.DB_USER) missing.push("DB_USER");
  if (!env.DB_NAME) missing.push("DB_NAME");
}
if (sessionSecret.length < 16) missing.push("SESSION_SECRET (mind. 16 Zeichen)");
if (!env.HEYGEN_API_KEY) missing.push("HEYGEN_API_KEY");

if (missing.length > 0) {
  console.error(`❌ Fehlende Konfiguration (APP_MODE=${env.APP_MODE}):`);
  for (const key of missing) console.error(`   - ${key}`);
  throw new Error(
    `Fehlende Konfiguration (APP_MODE=${env.APP_MODE}): ${missing.join(", ")}`
  );
}

const localStoragePath = resolve(
  env.LOCAL_STORAGE_PATH === "./storage" && isDesktop
    ? join(dataDir, "storage")
    : env.LOCAL_STORAGE_PATH
);

export const config = {
  mode: env.APP_MODE,
  isDesktop,
  port: env.PORT,
  isDev: env.NODE_ENV === "development",
  dataDir,

  db: {
    driver: dbDriver,
    sqlitePath,
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    name: env.DB_NAME,
  },

  queue: {
    driver: queueDriver,
  },

  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
  },

  heygen: {
    apiKey: env.HEYGEN_API_KEY,
    baseUrl: "https://api.heygen.com",
    maxConcurrency: env.HEYGEN_MAX_CONCURRENCY,
    requestsPerMinute: env.HEYGEN_REQUESTS_PER_MINUTE,
  },

  storage: {
    provider: env.STORAGE_PROVIDER,
    local: {
      path: localStoragePath,
      baseUrl: env.LOCAL_STORAGE_BASE_URL,
    },
    r2: {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucketName: env.R2_BUCKET_NAME,
      endpoint: env.R2_ACCOUNT_ID
        ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : "",
    },
    dropbox: {
      accessToken: env.DROPBOX_ACCESS_TOKEN,
      rootFolder: env.DROPBOX_ROOT_FOLDER,
    },
    googleDrive: {
      serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
      folderId: env.GOOGLE_DRIVE_FOLDER_ID,
    },
    onedrive: {
      clientId: env.ONEDRIVE_CLIENT_ID,
      clientSecret: env.ONEDRIVE_CLIENT_SECRET,
      tenantId: env.ONEDRIVE_TENANT_ID,
      driveId: env.ONEDRIVE_DRIVE_ID,
      rootFolder: env.ONEDRIVE_ROOT_FOLDER,
    },
  },

  session: {
    secret: sessionSecret,
  },
} as const;

export type StorageProvider = typeof env.STORAGE_PROVIDER;
