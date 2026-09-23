import { config, type StorageProvider } from "../config.js";

// ── Storage Interface ───────────────────────────────────────

export interface StorageAdapter {
  /** Upload file, returns a URL usable by HeyGen (must be publicly accessible or signed) */
  upload(key: string, body: Buffer | string, contentType: string): Promise<string>;

  /** Download file content */
  download(key: string): Promise<Buffer>;

  /** Delete a file */
  delete(key: string): Promise<void>;

  /** Get a time-limited download URL (for browser downloads) */
  getSignedDownloadUrl(key: string, expiresInSec?: number): Promise<string>;

  /**
   * Get a publicly accessible URL for HeyGen API.
   * HeyGen needs to fetch files (SRT uploads), so this must be reachable from the internet.
   * For local/Dropbox/Drive: returns a signed or shared link.
   */
  getPublicUrl(key: string): Promise<string>;

  /** Provider name for logging */
  readonly name: string;
}

// ── Factory ─────────────────────────────────────────────────

let _instance: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (_instance) return _instance;

  const provider = config.storage.provider;

  switch (provider) {
    case "local":
      _instance = createLocalStorage();
      break;
    case "r2":
      _instance = createR2Storage();
      break;
    case "dropbox":
      _instance = createDropboxStorage();
      break;
    case "google_drive":
      _instance = createGoogleDriveStorage();
      break;
    case "onedrive":
      _instance = createOneDriveStorage();
      break;
    default:
      throw new Error(`Unknown storage provider: ${provider}`);
  }

  console.log(`📦 Storage: ${_instance.name}`);
  return _instance;
}

// ── Local Filesystem ────────────────────────────────────────

import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createHmac } from "crypto";

function createLocalStorage(): StorageAdapter {
  const basePath = config.storage.local.path;
  // Die Desktop-App bindet einen frei gewählten Port, der zum Zeitpunkt der
  // Storage-Initialisierung noch nicht feststeht. Relative URLs lösen gegen die
  // Origin der Seite auf und bleiben dadurch immer korrekt; der Server-Modus
  // behält die konfigurierte absolute URL.
  const baseUrl = config.isDesktop ? "/files" : config.storage.local.baseUrl;

  // Sign URLs with HMAC so only our server can validate them
  function signUrl(key: string, expiresAt: number): string {
    const payload = `${key}:${expiresAt}`;
    const sig = createHmac("sha256", config.session.secret)
      .update(payload)
      .digest("hex")
      .slice(0, 16);
    return `${baseUrl}/${key}?expires=${expiresAt}&sig=${sig}`;
  }

  return {
    name: "Local Filesystem",

    async upload(key, body, _contentType) {
      const filePath = join(basePath, key);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, body);
      return signUrl(key, Date.now() + 86400_000); // 24h
    },

    async download(key) {
      return readFile(join(basePath, key));
    },

    async delete(key) {
      try { await unlink(join(basePath, key)); } catch {}
    },

    async getSignedDownloadUrl(key, expiresInSec = 3600) {
      return signUrl(key, Date.now() + expiresInSec * 1000);
    },

    async getPublicUrl(key) {
      // For HeyGen: needs to be internet-reachable.
      // In production, LOCAL_STORAGE_BASE_URL should point to your public domain.
      return signUrl(key, Date.now() + 3600_000);
    },
  };
}

// ── Cloudflare R2 (S3-compatible) ───────────────────────────

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function createR2Storage(): StorageAdapter {
  const cfg = config.storage.r2;
  const s3 = new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

  return {
    name: "Cloudflare R2",

    async upload(key, body, contentType) {
      await s3.send(new PutObjectCommand({
        Bucket: cfg.bucketName, Key: key, Body: body, ContentType: contentType,
      }));
      // Return signed URL (R2 public access needs bucket-level config)
      return this.getPublicUrl(key);
    },

    async download(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: cfg.bucketName, Key: key }));
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },

    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucketName, Key: key }));
    },

    async getSignedDownloadUrl(key, expiresInSec = 3600) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucketName, Key: key }), { expiresIn: expiresInSec });
    },

    async getPublicUrl(key) {
      // Use signed URL valid for 1h (HeyGen fetches within seconds)
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucketName, Key: key }), { expiresIn: 3600 });
    },
  };
}

// ── Dropbox ─────────────────────────────────────────────────

function createDropboxStorage(): StorageAdapter {
  const cfg = config.storage.dropbox;

  // Lazy import to avoid loading if not used
  let dbx: any = null;
  async function getDbx() {
    if (dbx) return dbx;
    const { Dropbox } = await import("dropbox");
    dbx = new Dropbox({ accessToken: cfg.accessToken });
    return dbx;
  }

  function fullPath(key: string) {
    return `${cfg.rootFolder}/${key}`;
  }

  return {
    name: "Dropbox",

    async upload(key, body, _contentType) {
      const client = await getDbx();
      const buf = typeof body === "string" ? Buffer.from(body) : body;
      await client.filesUpload({
        path: fullPath(key),
        contents: buf,
        mode: { ".tag": "overwrite" },
      });
      return this.getPublicUrl(key);
    },

    async download(key) {
      const client = await getDbx();
      const result = await client.filesDownload({ path: fullPath(key) });
      // filesDownload returns fileBinary in Node.js
      return Buffer.from((result.result as any).fileBinary);
    },

    async delete(key) {
      const client = await getDbx();
      try { await client.filesDeleteV2({ path: fullPath(key) }); } catch {}
    },

    async getSignedDownloadUrl(key, _expiresInSec = 3600) {
      const client = await getDbx();
      const result = await client.filesGetTemporaryLink({ path: fullPath(key) });
      return result.result.link;
    },

    async getPublicUrl(key) {
      // Temporary link is valid for 4 hours, enough for HeyGen
      return this.getSignedDownloadUrl(key);
    },
  };
}

// ── Google Drive ────────────────────────────────────────────

function createGoogleDriveStorage(): StorageAdapter {
  const cfg = config.storage.googleDrive;

  let drive: any = null;
  async function getDrive() {
    if (drive) return drive;
    const { google } = await import("googleapis");
    const credentials = JSON.parse(cfg.serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    drive = google.drive({ version: "v3", auth });
    return drive;
  }

  // Map key → Google Drive file ID (cached in memory, could also use DB)
  const keyToFileId = new Map<string, string>();

  return {
    name: "Google Drive",

    async upload(key, body, contentType) {
      const client = await getDrive();
      const buf = typeof body === "string" ? Buffer.from(body) : body;
      const { Readable } = await import("stream");

      const existingId = keyToFileId.get(key);

      if (existingId) {
        // Update existing file
        await client.files.update({
          fileId: existingId,
          media: { mimeType: contentType, body: Readable.from(buf) },
        });
        return this.getPublicUrl(key);
      }

      // Create new file
      const res = await client.files.create({
        requestBody: {
          name: key.split("/").pop(),
          parents: [cfg.folderId],
          properties: { storageKey: key },
        },
        media: { mimeType: contentType, body: Readable.from(buf) },
        fields: "id",
      });

      keyToFileId.set(key, res.data.id!);

      // Make file accessible via link (for HeyGen)
      await client.permissions.create({
        fileId: res.data.id!,
        requestBody: { role: "reader", type: "anyone" },
      });

      return this.getPublicUrl(key);
    },

    async download(key) {
      const client = await getDrive();
      const fileId = keyToFileId.get(key);
      if (!fileId) throw new Error(`Google Drive file not found: ${key}`);

      const res = await client.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
      );
      return Buffer.from(res.data as ArrayBuffer);
    },

    async delete(key) {
      const client = await getDrive();
      const fileId = keyToFileId.get(key);
      if (!fileId) return;
      try { await client.files.delete({ fileId }); } catch {}
      keyToFileId.delete(key);
    },

    async getSignedDownloadUrl(key) {
      const fileId = keyToFileId.get(key);
      if (!fileId) throw new Error(`Google Drive file not found: ${key}`);
      return `https://drive.google.com/uc?export=download&id=${fileId}`;
    },

    async getPublicUrl(key) {
      return this.getSignedDownloadUrl(key);
    },
  };
}

// ── Microsoft OneDrive ──────────────────────────────────────

function createOneDriveStorage(): StorageAdapter {
  const cfg = config.storage.onedrive;

  let client: any = null;
  let accessToken: string = "";
  let tokenExpiry = 0;

  async function getToken(): Promise<string> {
    if (Date.now() < tokenExpiry - 60_000) return accessToken;

    const res = await fetch(
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      }
    );
    const data = await res.json() as any;
    accessToken = data.access_token;
    tokenExpiry = Date.now() + data.expires_in * 1000;
    return accessToken;
  }

  function apiPath(key: string) {
    const fullPath = `${cfg.rootFolder}/${key}`.replace(/\/+/g, "/");
    return `/drives/${cfg.driveId}/root:${fullPath}:`;
  }

  return {
    name: "Microsoft OneDrive",

    async upload(key, body, contentType) {
      const token = await getToken();
      const buf = typeof body === "string" ? Buffer.from(body) : body;

      await fetch(`https://graph.microsoft.com/v1.0${apiPath(key)}/content`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
        },
        body: buf,
      });

      return this.getPublicUrl(key);
    },

    async download(key) {
      const token = await getToken();
      const res = await fetch(`https://graph.microsoft.com/v1.0${apiPath(key)}/content`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return Buffer.from(await res.arrayBuffer());
    },

    async delete(key) {
      const token = await getToken();
      try {
        await fetch(`https://graph.microsoft.com/v1.0${apiPath(key)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {}
    },

    async getSignedDownloadUrl(key) {
      const token = await getToken();
      const res = await fetch(
        `https://graph.microsoft.com/v1.0${apiPath(key)}/createLink`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ type: "view", scope: "anonymous" }),
        }
      );
      const data = await res.json() as any;
      return data.link?.webUrl ?? "";
    },

    async getPublicUrl(key) {
      return this.getSignedDownloadUrl(key);
    },
  };
}
