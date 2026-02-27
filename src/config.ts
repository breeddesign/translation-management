import "dotenv/config";
import { z } from "zod";

const storageProvider = z.enum(["r2", "dropbox", "google_drive", "onedrive", "local"]);

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production"]).default("development"),

  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().default(""),

  HEYGEN_API_KEY: z.string().min(1),
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

  SESSION_SECRET: z.string().min(16),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  isDev: env.NODE_ENV === "development",

  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    name: env.DB_NAME,
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
      path: env.LOCAL_STORAGE_PATH,
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
    secret: env.SESSION_SECRET,
  },
} as const;

export type StorageProvider = typeof env.STORAGE_PROVIDER;
