# HeyGen Proofreader v2

Batch-Video-Translation & Proofread-Management für die **HeyGen v3 API** (`/v3/video-translations`).  
Production-hardened mit Idempotenz, State Machine, Rate Limiting und austauschbarem Storage.

## Zwei Betriebsmodi

Dieselbe Codebasis läuft in zwei Infrastruktur-Profilen, umgeschaltet über `APP_MODE`:

| | `server` (Deployment) | `desktop` (Mac-App) |
|---|---|---|
| Datenbank | MySQL 8 | SQLite (Datei) |
| Queue | BullMQ + Redis | SQLite-Queue in-process |
| Rate-Limiter | Redis Token Bucket | In-Memory Token Bucket |
| Prozesse | Web + Worker getrennt | ein Prozess |
| Voraussetzungen | Docker/MySQL/Redis | keine |

Routen, Views und Job-Prozessoren sind in beiden Modi identisch — ausgetauscht
wird nur die Infrastrukturschicht (`src/db/index.ts`, `src/queue/index.ts`,
`src/lib/rate-limiter.ts`).

### Mac-App bauen und starten

```bash
npm run desktop:rebuild   # einmalig: better-sqlite3 für Electrons ABI bauen
npm run desktop           # App im Entwicklungsmodus starten
npm run dist:mac          # .dmg bauen → ~/Builds/heygen-proofreader/

npm run dev:desktop       # Desktop-Laufzeit headless auf Port 3010 (ohne Electron)
```

Der Build landet bewusst **außerhalb des Projektordners**: Das Repository liegt in
Dropbox, und der Sync greift während des Packens in das `.app`-Bündel ein — die
Signierung schlägt dann mit „Application … could not be found“ fehl.

`npm run desktop` setzt `env -u ELECTRON_RUN_AS_NODE`, weil VS-Code-Terminals
diese Variable vererben; Electron würde sonst als reines Node starten und beim
Import von `electron` scheitern.

Signiert wird **ad-hoc** (`”identity”: “-”` in `build.mac`). Das ist bewusst so:
Eine Signatur mit dem persönlichen „Apple Development”-Zertifikat funktioniert
zwar auch, läuft aber ab — danach baut electron-builder still unsigniert weiter,
und solche Bundles meldet macOS als „beschädigt” (ohne „Trotzdem öffnen”-Ausweg).
Die Ad-hoc-Signatur läuft nie ab und genügt für den lokalen Gebrauch auf Apple
Silicon. `hardenedRuntime` ist dabei aus, weil ohne echtes Zertifikat keine
Entitlements vergeben werden können.

Soll die App an Dritte gehen, führt kein Weg an einem „Developer ID”-Zertifikat
plus Notarisierung vorbei (Apple Developer Program, ~99 €/Jahr).

### Frontend-Abhängigkeiten

Tailwind, HTMX samt Erweiterungen und die Icon-Schrift werden **lokal
ausgeliefert**, nicht per CDN — sonst würde ein unpkg-Ausfall die gesamte
Oberfläche lahmlegen. `npm run build` erzeugt alles nach `public/static/`:

- `app.css` — Tailwind v3, gegen die Templates gebaut (~19 KB statt der
  JIT-Compiler-CDN). v3, weil die Oberfläche dagegen entwickelt wurde; v4 hat
  Utilities umbenannt.
- `material-symbols-rounded.woff2` — nur die tatsächlich verwendeten Symbole
  (~5 KB statt 5,1 MB). `scripts/build-icon-font.mjs` liest die Icon-Namen aus
  den Templates und holt die passende Teilmenge von Google Fonts; ohne Netz
  fällt es auf die vollständige Schrift aus `node_modules` zurück.
- `htmx.min.js` und die beiden Erweiterungen aus `node_modules`.

Neue Icons erscheinen erst nach `npm run build` — der Subset wird beim Bauen
aus den Templates abgeleitet.

Beim ersten Start fragt die App den HeyGen-API-Key ab und legt ihn zusammen mit
Datenbank und Downloads unter `~/Library/Application Support/HeyGen Proofreader`
ab. Der Webserver bindet auf einen freien Port, sodass eine parallel laufende
Server-Instanz nicht kollidiert. Menü „Ablage“ öffnet Download- und Datenordner.

Bearbeitete SRTs gehen als **HeyGen-Asset** (`POST /v3/assets`) zurück, nicht über
eine URL. Andernfalls müsste HeyGen den Storage selbst abrufen können — bei
lokalem Storage unmöglich. Damit funktioniert der Proofread-Rückweg auch in der
Desktop-App und im Server-Modus ohne öffentliche Domain.

Die lokale Queue bildet die genutzten BullMQ-Eigenschaften nach: deterministische
Job-IDs (Dedup), verzögerter Start, Retries mit Fixed/Exponential-Backoff sowie
Zähler und Fehlerliste für die Jobs-Seite. Jobs sind persistent und werden nach
einem Neustart fortgesetzt; beim Beenden unterbrochene Jobs werden neu eingereiht.

## Asset-Download (Video + Captions)

Fertige Übersetzungen werden automatisch von HeyGen in den Storage gezogen —
**ohne Credits zu verbrauchen** (nur GET-Downloads; Credits fallen nur bei der Generierung an):

- **Video** (`video.mp4`) — die Originaldatei von HeyGen (`original.mp4`, 1080p H.264,
  ohne erneute Kompression); HeyGen-URLs laufen ab, die lokale Kopie nicht
- **VTT-Captions** (`captions.vtt`) — direkt von HeyGen (`vtt_caption_url`); Fallback: lokale SRT→VTT-Konvertierung
- **SRT-Captions** (`captions.srt`)

Ablage unter `translated/{videoId}/{language}/{translatedId}/`. Der `download-assets`-Worker
wird nach jedem fertigen Video automatisch enqueued; manuell nachziehen geht über die UI
("Assets von HeyGen ziehen") oder `POST /api/projects/:id/pull-assets` bzw. `POST /api/translated/:id/pull`.
Download-Links: `GET /api/translated/:id/asset/video|vtt|srt` (signed URLs).

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
│  └── Queue Enqueue (addBulk)         │    │  ├── PollVideoProcessor       │
│                                      │    │  └── DownloadAssetsProcessor  │
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
            └── id, heygen_video_translate_id, idempotency_key, status, video_url,
                storage_key (Video), vtt_storage_key, srt_storage_key
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
Der Workflow im UI ist dann: Projekt anlegen → Video-URLs einfügen → "Proofreads generieren" → Excel runterladen & editieren → Excel hochladen → "Videos generieren" → Videos + Captions (VTT/SRT) landen automatisch im Storage und sind pro Zeile downloadbar. Alles mit Live-Status-Updates via HTMX.

## HeyGen v3 API — Hinweise

- Endpunkte: `POST/GET /v3/video-translations`, `.../proofreads` (create/status/srt/generate), `.../{id}/caption?format=srt|vtt`
- `GET /v3/video-translations/{id}` liefert bei `completed` direkt `video_url`, `srt_caption_url` und `vtt_caption_url`
- Captions werden in v3 **immer** generiert — das alte `captions`-Setting ist obsolet und wird ignoriert
- Settings-Mapping: `mode: "fast"` → `speed`, `"quality"` → `precision`
- Fehler kommen als HTTP-Statuscodes (400/401/404/429 mit `Retry-After`), nicht mehr als `error`-Feld
