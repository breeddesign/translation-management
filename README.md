vorlge# HeyGen Proofreader v2

Batch-Video-Translation & Proofread-Management für HeyGen API.  
Production-hardened mit Idempotenz, State Machine, Rate Limiting und austauschbarem Storage.

## Stack

| Komponente | Technologie | Grund |
|---|---|---|
| Runtime | **Node.js 20+** (TypeScript) |
| Framework | **Hono** | Schnell, leichtgewichtig |
| DB | **MySQL 8** | 
| Queue | **BullMQ + Redis** | Robustes Retry, Concurrency-Limits |
| Frontend | **HTMX + Handlebars + Tailwind** | Server-rendered, Smart-Polling |
| Excel | **ExcelJS** | SRT ↔ Excel mit Revisions-Tracking |
| Storage | **Pluggable** (Local/R2/Dropbox/Google Drive/OneDrive) | |
| Deploy | **IONOS vServer** | über Coolify gemanagte

## Architektur (2 Prozesse)

```
┌─── Web Process ──────────────────────┐    ┌─── Worker Process ────────────┐
│  Hono HTTP Server                    │    │  BullMQ Workers               │
│  ├── API Routes (JSON)               │    │  ├── ProofreadProcessor       │
│  ├── Page Routes (HTMX/HTML)         │    │  ├── PollProofreadProcessor   │
│  ├── Local File Serving (signed URL) │    │  ├── GenerateVideoProcessor   │
│  └── Queue Enqueue (addBulk)         │    │  └── PollVideoProcessor       │
│                                      │    │                               │
│  ↕ Redis (Queues)                    │    │  ↕ Redis (Queues + Rate Limit)│
│  ↕ MySQL (read/write)               │    │  ↕ MySQL (read/write)         │
│  ↕ Storage (signed URLs)             │    │  ↕ Storage (upload/download)  │
└──────────────────────────────────────┘    │  ↕ HeyGen API                 │
                                            └───────────────────────────────┘
```

**Warum 2 Prozesse?**
- Web-Deploy/Restart unterbricht keine laufenden Jobs
- Worker kann unabhängig skaliert werden
- Worker-Crash betrifft nicht die Web-UI

## Verbesserungen gegenüber v1

### 1. Separate Web + Worker Prozesse
```bash
npm run dev        # Web: HTTP Server
npm run dev:worker # Worker: BullMQ Processors
npm run dev:all    # Beide parallel (concurrently)
```

### 2. Idempotenz & Dedup
- **Deterministische Job-IDs**: `proofread:{projectId}:{videoId}` verhindert Doppel-Enqueue
- **Idempotency Key** in DB: `{projectId}:{videoId}:{language}` → Unique Constraint
- **State Machine**: Status-Transition nur wenn `WHERE status IN ('expected_states')`

### 3. Rate Limiting (Token Bucket in Redis)
- Nicht nur BullMQ Concurrency, sondern echtes Requests/Minute Limit
- Token Bucket mit automatischem Refill
- Jitter auf Polling-Intervalle (verhindert Thundering Herd)
- Konfigurierbar: `HEYGEN_REQUESTS_PER_MINUTE=30`

### 4. Smart HTMX Polling
- **3 Sekunden** wenn Jobs aktiv sind
- **30 Sekunden** wenn alles idle ist
- Server liefert `hasActiveJobs` Flag im Status-Response
- Client-JS passt Polling-Intervall dynamisch an

### 5. Excel Revisions-Tracking
- Jeder Upload erstellt eine neue Revision (v0, v1, v2...)
- `proofread_revisions` Tabelle: Audit-Trail mit Diff-Summary
- API: `GET /api/proofreads/:id/revisions` für History
- Re-Upload möglich nach Edit

### 6. Pluggable Storage (statt nur R2)
```bash
STORAGE_PROVIDER=local          # Lokales Filesystem (Default)
STORAGE_PROVIDER=r2             # Cloudflare R2
STORAGE_PROVIDER=dropbox        # Dropbox API
STORAGE_PROVIDER=google_drive   # Google Drive (Service Account)
STORAGE_PROVIDER=onedrive       # Microsoft OneDrive (App Registration)
```

Alle Downloads über **Signed URLs** (zeitlich begrenzt). Keine öffentlichen Dateien.

## Setup

```bash
# 1. Clone & Install
git clone <repo> && cd heygen-proofreader
npm install

# 2. Konfiguration
cp .env.example .env
# → MySQL/Redis Credentials
# → HEYGEN_API_KEY eintragen
# → STORAGE_PROVIDER wählen + konfigurieren

# 3. Datenbank
npm run db:migrate

# 4. Starten (Development)
npm run dev:all   # Web + Worker parallel

# 5. Starten (Production)
npm run build
npm run start:web &
npm run start:worker &
```

## Datenmodell

```
projects
├── id, name, heygen_folder_id, settings (JSON), status
└── videos[]
    ├── id, title, video_url, storage_key, status
    └── proofreads[]
        ├── id, language, heygen_proofread_id, idempotency_key
        ├── status, excel_revision, excel_storage_key
        ├── proofread_revisions[] (audit trail)
        │   └── revision, excel_storage_key, srt_storage_key, diff_summary
        └── translated_videos[]
            └── id, heygen_video_translate_id, idempotency_key, status, video_url
```

## Status-Maschine

```
Proofread:   pending → processing → completed → edited → generating → done
                         ↓             ↓          ↓         ↓
                       failed ←──────────────────────────────┘
                         ↓
                       pending (retry)

Translated:  pending → processing → completed
                         ↓
                       failed → pending (retry)
```


## UI 
Der Workflow im UI ist dann: Projekt anlegen → Video-URLs einfügen → "Proofreads generieren" → Excel runterladen & editieren → Excel hochladen → "Videos generieren" → Fertige Videos downloaden. Alles mit Live-Status-Updates via HTMX.
