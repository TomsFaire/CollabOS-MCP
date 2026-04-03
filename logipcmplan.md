# Logitech CollabOS Device Management Platform — Implementation Plan

## Context

Faire uses many Logitech CollabOS conference room devices (Rally Bar series, etc.). This project builds:

1. **MCP server** — tools so Cursor (and other MCP clients) can read cached CollabOS room/device state and run **`refresh_device`** for an immediate LAN poll
2. **Web dashboard** (optional) — at-a-glance room status for IT/AV staff; disable with `DISABLE_DASHBOARD=1` for MCP-only

**Out of scope for now:** third-party metrics sinks (e.g. Datadog). Telemetry lives in **SQLite** and **MCP tool results** only.

**Account scope:** Only the **local CollabOS Device Management API** is available (per-device on LAN). **Logitech Sync Cloud API is out of scope** — no cloud credentials, no fleet control plane from Sync.

**Data sources:**
- **Local CollabOS API** (LAN, per-device IP): **Read-only** in the published spec. 4 GET endpoints (+ sign-in). Bearer token auth (15-min tokens). 10 req/min rate limit (other APIs). Covers device config, peripherals, room occupancy + environmental sensors (CO2, temp, humidity, TVOC, PM2.5/PM10, pressure), device state (call status, mic/speaker).
- **Not used:** Logitech Sync Cloud API (reboot, cloud settings, fleet management) — not licensed / not available at current account tier.

**Device inventory source:** CSV export from Zoom admin portal.

---

## Features you give up without Sync Cloud

| Capability | Notes |
|------------|--------|
| **Remote reboot from *this* repo** | CollabOS local API is read-only here; **no `reboot_device` tool in LogiSync**. Reboot via **Zoom** (admin / API) is a separate concern — see **Combining with Zoom MCP** below. |
| **Cloud-side fleet settings** | Policies, schedules, and bulk configuration pushed from Logitech Sync portal APIs are unavailable to this app. |
| **Sync-native inventory as source of truth** | You already use **Zoom CSV** for inventory; that remains the right source. Sync’s device list is not integrated. |
| **Future Sync-only telemetry** | Anything exposed only in Sync (not duplicated on CollabOS local APIs) is invisible here. |

**What you keep:** Everything that CollabOS exposes on the LAN — room insights, env sensors (where supported), peripherals, call/AV state, plus **polling, SQLite cache, optional dashboard, and MCP read + `refresh_device`** (direct path from devices → cache → model).

---

## Combining with Zoom MCP ([echelon-ai-labs/zoom-mcp](https://github.com/echelon-ai-labs/zoom-mcp))

**Yes — without merging codebases.** Register **two** MCP servers in Cursor (or Claude Desktop): **LogiSync** (this project) for **LAN / CollabOS** telemetry and cache refresh, and **[zoom-mcp](https://github.com/echelon-ai-labs/zoom-mcp)** for **Zoom Server-to-Server OAuth** APIs (users, meetings, recordings, and any Zoom Room / device endpoints you add or that the server exposes).

### Division of responsibility

| Concern | LogiSync (this repo) | Zoom MCP (Python) |
|--------|----------------------|-------------------|
| CO₂, temp, occupancy, presence, mic/speaker, peripherals | Yes (CollabOS poll + SQLite) | No (unless Zoom adds equivalent APIs) |
| Inventory alignment with Zoom export | CSV import → SQLite | Live Zoom APIs if you implement/list devices |
| Reboot / Zoom-side room actions | Not in CollabOS API | **Candidate** — depends on Zoom API scopes + tools implemented in zoom-mcp |

### How “bringing together” works

1. **Assistant layer (default):** The model calls **LogiSync** tools for granular device/room state, then **Zoom** tools for account-level or Zoom-controlled actions. It correlates rows using **`Assignment` / `room_name`** and **`Serial Number`** from your CSV against whatever identifiers Zoom’s API returns (room name, device id, etc.). No shared database required.
2. **Optional later:** A small **bridge** (script or new tool) that joins Zoom device list API responses with SQLite `devices` on a schedule — only if you want a single dashboard source of truth; that is extra scope beyond dual MCP.

### Caveats

- **zoom-mcp scope:** The public README emphasizes users, meetings, and recordings. **Room device reboot** may require **additional Zoom API scopes** and **new tools** in zoom-mcp (or a fork) if not already present — confirm against [the repo](https://github.com/echelon-ai-labs/zoom-mcp) and Zoom’s Room / device APIs.
- **Two runtimes:** LogiSync is **Node**; zoom-mcp is **Python** — each needs its own `.env` and process; Cursor runs both as separate MCP commands.
- **Trust:** Third-party MCP servers handle OAuth secrets; review code and scopes before production use.

### Cursor wiring

Project file **`.cursor/mcp.json`** registers **logisync** and **zoom** together. See **`README.md`** for clone path (`../zoom-mcp`), `uv run zoom-mcp`, and restart instructions.

---

## Architecture

```
CSV Import ──→ Device Registry (SQLite)
                       │
               Background Poller (every 60s, configurable)
               └──→ Local CollabOS API (per device IP on LAN)
                         └──→ Device State Cache (SQLite)

MCP Server ←──→ SQLite (reads cache; refresh = new CollabOS poll)

Dashboard ←──→ Express REST API ←──→ SQLite   (optional)
```

Single Node.js process. MCP server + dashboard REST API served from same process.

---

## Tech Stack

- **Runtime:** Node.js 18+ / TypeScript
- **MCP:** `@modelcontextprotocol/sdk`
- **HTTP server:** Express
- **Database:** SQLite via `better-sqlite3`
- **HTTP client:** native `fetch` (undici) with optional TLS relax for appliance certs
- **CSV parsing:** `csv-parse`

**Dashboard security (production):** Treat room inventory and live status as internal data. MVP: bind to localhost or a trusted network only. Production: put the Express app behind SSO, VPN, mTLS, or reverse-proxy auth; do not expose CSV upload or device APIs to the public internet without authentication.

---

## Project Structure

```
logisync-mcp/
├── src/
│   ├── index.ts                  # Entry: starts MCP server + poller + dashboard
│   ├── config.ts                 # Env-based config
│   ├── db/
│   │   └── store.ts              # SQLite schema + read/write helpers
│   ├── devices/
│   │   ├── registry.ts           # Device CRUD, CSV import
│   │   ├── local-api.ts          # CollabOS local device API client
│   │   └── poller.ts             # Background polling loop
│   ├── mcp/
│   │   └── server.ts             # MCP server + tool definitions
│   └── dashboard/
│       ├── router.ts             # Express REST endpoints
│       └── public/               # Static HTML/CSS/JS
│           ├── index.html
│           ├── app.js
│           └── style.css
├── device-management-api.yaml    # Local CollabOS OpenAPI spec (reference)
├── devices.csv                   # Template / seed CSV
├── package.json
├── tsconfig.json
└── .env
```

---

## Database Schema

**`devices` table**
```sql
id TEXT PRIMARY KEY,           -- serial number (stable key)
room_name TEXT NOT NULL,       -- from Assignment column (e.g. "SFO-100P-FL03-Herman-07 (3)")
ip_address TEXT NOT NULL,      -- updated on each CSV re-import
model_name TEXT,               -- Rally Bar, Rally Bar Mini, RallyBarHuddle, Roommate
firmware_version TEXT,         -- from Platform OS Version
mac_address TEXT,
office TEXT,                   -- derived from Assignment prefix (SFO, NYC, KW, TOR)
active INTEGER NOT NULL DEFAULT 1,   -- 0 = missing from last CSV import (soft-remove); never auto-purge
removed_from_import_at INTEGER,      -- epoch ms when row was last marked absent from CSV (nullable)
last_seen_at INTEGER           -- epoch ms (from successful local API poll; distinct from Zoom bootstrap)
```

**`device_states` table**
```sql
device_id TEXT PRIMARY KEY REFERENCES devices(id),
polled_at INTEGER,             -- last successful local CollabOS poll (null = never polled successfully)
online BOOLEAN,                -- authoritative from poller: true if last poll succeeded; false on errors/timeout
device_state TEXT,             -- IDLE | IN_USE | AUDIO_ONLY
mic_state TEXT,
speaker_state TEXT,
speaker_volume INTEGER,
occupancy_count INTEGER,
presence TEXT,                 -- OCCUPIED | UNOCCUPIED
co2 REAL, temp REAL, humidity REAL, tvoc REAL, pm25 REAL, pm10 REAL, pressure REAL,
raw_json TEXT
```

---

## CSV Import Format (from Zoom export)

Actual columns from the live Zoom export:
```
Device Name, Status, Platform OS, App Version, Platform OS Version, Device Type,
Vendor, Model, Enrollment, Assignment, IP Address, MAC Address, Serial Number,
Last in Service, Asset Tag
```

Column mapping:
| CSV Column | DB Field | Notes |
|---|---|---|
| `Assignment` | `room_name` | Cleaner than Device Name (e.g. "SFO-100P-FL03-Herman-07 (3)") |
| `Serial Number` | `id` (primary key) | Stable across IP changes |
| `IP Address` | `ip_address` | Updated on re-import |
| `Model` | `model_name` | Rally Bar, Rally Bar Mini, RallyBarHuddle, Roommate |
| `Platform OS Version` | `firmware_version` | e.g. "Logitech Rally Bar 2.0.105" |
| `MAC Address` | `mac_address` | Stored but not used for polling |
| `Status` | optional bootstrap hint only | See “Zoom vs poller” below — not the source of truth for `online` |

**Zoom `Status` vs poller `online`:** On **first insert** for a device, optionally map Zoom `Status` into `device_states` as a **placeholder** until the first local poll runs (e.g. seed `online` from Zoom, set `polled_at` null). After any successful CollabOS poll, **`online` and all sensor/AV fields come only from the poller**; do not periodically overwrite poller truth from Zoom. Zoom never reconciles against poller in steady state.

**Import behavior:**
- Filter out non-Logitech rows (where `Vendor` ≠ "Logitech" or `Serial Number` is `'-`)
- **Upsert by Serial Number** — updates `ip_address`, `room_name`, `firmware_version` for existing devices; set `active = 1`, clear `removed_from_import_at` when serial reappears
- New devices are inserted; serials **absent** from a new CSV are **soft-removed**: set `active = 0`, set `removed_from_import_at` — **no auto-delete**; hard delete only via explicit operator action (dashboard or future tool)
- `Assignment` prefix encodes office location: `KW-`, `NYC-`, `SFO-`, `TOR-`, etc.

**Multi-office networking note:** Faire has ~65 devices across 4 offices on separate subnets (KW: 10.0.26.x, NYC: 10.7.131.x, SFO: 10.4.24.x/10.4.25.x, TOR: 10.0.152.x). Local API polling requires network routing to each subnet — either run from a host with site-to-site routing, or deploy a polling agent per office (future consideration).

---

## Local API Client (`local-api.ts`)

- **Base URL per device:** `https://{ip_address}/` (or scheme/host from config) — credentials are shared, but tokens and HTTP sessions are **per device** because each CollabOS instance is separate.
- Token cache per device (refresh before 15-min expiry, retry on 401)
- Shared credential: `COLLAB_OS_USERNAME` / `COLLAB_OS_PASSWORD` from env
- Wraps: `/api/v1/device`, `/api/v1/peripherals`, `/api/v1/insights/room`, `/api/v1/insights/device`
- Reference: `device-management-api.yaml`

---

## Background poller (`poller.ts`)

Avoid a single slow or dead IP blocking the whole fleet for a full interval.

- **Bounded concurrency:** `POLL_CONCURRENCY` (e.g. 5–10) — poll N devices in parallel, not all 65 sequentially.
- **Per-device timeout:** `POLL_PER_DEVICE_TIMEOUT_MS` — abort one device’s requests and mark `online = false` without stalling the batch.
- **Jitter:** small random delay at the start of each cycle (`POLL_JITTER_MS_MAX`) so all devices do not align on the same second.
- **Rate limit:** Stay within **10 req/min per device**; one cycle’s GETs per device must fit that budget (4 endpoints × 1 cycle/min is fine).

---

## MCP Tools (CollabOS + cache only)

| Tool | Description |
|------|-------------|
| `list_rooms` | All rooms with status summary |
| `get_room_status` | Full status for a room (occupancy, env, AV) |
| `get_device_config` | Hardware/firmware info (from last poll) |
| `get_peripherals` | Connected cameras, displays, controllers (from last poll) |
| `list_offline_devices` | Devices that are **stale** or **never successfully polled** (see Offline / stale semantics) |
| `import_devices` | Prefer **absolute path** to a CSV on the server; optional **inline CSV** for small files; **dashboard upload** for large exports |
| `refresh_device` | Force immediate CollabOS poll for one device |

---

## Offline / stale semantics (`list_offline_devices`, dashboard)

- **Never polled:** `polled_at` is null — always include in offline/stale lists (or show “unknown” in UI).
- **Stale:** `polled_at` older than threshold — default **`OFFLINE_STALE_SECONDS`** = `max(300, 2 * POLL_INTERVAL_SECONDS)` so the threshold scales with poll interval (override via env if needed).
- **Unreachable this cycle:** `online = false` after failed/timeout poll; may still be “fresh” if `polled_at` is recent — distinguish **offline** (last poll failed) from **stale** (no successful poll within threshold) in tool responses and UI copy.

---

## Configuration (`.env`)

```
POLL_INTERVAL_SECONDS=60
POLL_CONCURRENCY=8
POLL_PER_DEVICE_TIMEOUT_MS=12000
POLL_JITTER_MS_MAX=3000
OFFLINE_STALE_SECONDS=            # optional; default max(300, 2 * POLL_INTERVAL_SECONDS)
DASHBOARD_PORT=3000
DATABASE_PATH=./data/logisync.db
COLLAB_OS_USERNAME=admin
COLLAB_OS_PASSWORD=
COLLAB_OS_TLS_INSECURE=true
DISABLE_MCP=0
DISABLE_POLLER=0
DISABLE_DASHBOARD=0
```

---

## Token-Optimized Phase Breakdown

### Model Guide
- **Haiku 4.5** — scaffold, boilerplate, schema, config, CSV parsing (mechanical, low complexity)
- **Sonnet 4.6** — API clients, poller, MCP tools, dashboard backend (most implementation work)
- **Opus 4.6** — reserve for complex token management logic or architectural pivots (likely not needed)

---

### Session 1 — Scaffold (parallel, ~20k tokens total)

Three independent agents can run in parallel:

| Agent | Model | Files | Est. Tokens |
|-------|-------|-------|-------------|
| 1A: Project scaffold | Haiku | `package.json`, `tsconfig.json`, `.env` template | ~5k |
| 1B: Database layer | Haiku | `src/db/store.ts` | ~8k |
| 1C: CSV import + device registry | Haiku | `src/devices/registry.ts`, `devices.csv` template | ~8k |

**Parallelism:** **1A** is independent. **1B must expose the schema and a stable `store` API first** — **1C** depends on those exports (types, `upsertDevice`, etc.). Run **1B before or with a short head start**, then 1C; or run 1A+1B in parallel, then 1C immediately after 1B’s interface is fixed.
**Verification:** `npx ts-node src/db/store.ts` initializes DB; `npm test` (if tests are added).

---

### Session 2 — Local API Client (~25k tokens)

Single focused session. Requires reading `device-management-api.yaml` (~15k tokens of spec).

| Agent | Model | Files | Est. Tokens |
|-------|-------|-------|-------------|
| 2A: CollabOS API client | Sonnet | `src/devices/local-api.ts`, `src/config.ts` | ~25k |

**Dependencies:** Session 1B complete (needs config types).
**Verification:** Test against a real device on LAN. Log raw API responses.

---

### Session 3 — Poller (~12k tokens)

Single agent after Session 2 completes:

| Agent | Model | Files | Est. Tokens |
|-------|-------|-------|-------------|
| 3A: Background poller | Sonnet | `src/devices/poller.ts` | ~12k |

**Dependencies:** Session 2 (local API client).
**Poller implementation:** Must follow **Background poller** section (concurrency, per-device timeout, jitter, rate limits).
**Verification:** Run poller for 2+ cycles; SQLite `device_states` updates.

---

### Session 4 — MCP Server (~30k tokens)

Single focused session. **Seven tools** (no cloud reboot).

| Agent | Model | Files | Est. Tokens |
|-------|-------|-------|-------------|
| 4A: MCP server + tools | Sonnet | `src/mcp/server.ts` | ~30k |

**Dependencies:** Sessions 1B, 2, 3A complete.
**Verification:** Load in Claude Desktop. Test `list_rooms`, `get_room_status`, `list_offline_devices`, `refresh_device`.

---

### Session 5 — Dashboard (parallel with Session 4, ~40k tokens)

Can start **API and UI** immediately after Session 1B. **Independent of MCP server.**

| Agent | Model | Files | Est. Tokens |
|-------|-------|-------|-------------|
| 5A: Dashboard backend | Sonnet | `src/dashboard/router.ts` | ~15k |
| 5B: Dashboard frontend | Sonnet | `src/dashboard/public/` (HTML, CSS, JS) | ~25k |

**Parallelism:** 5A and 5B can be split. 5B is purely static, no DB knowledge needed.
**Dependencies:** 5A needs Session 1B. 5B is fully independent.
**Live status:** Room cards show **fresh** occupancy/AV/env colors only after **Session 3A (poller)** is running (or after manual `refresh_device`). Before that, expect placeholder/Zoom-bootstrap or empty `device_states` — verify UI handles “never polled” / stale gracefully.
**Verification:** Open `http://localhost:3000`. Upload CSV, verify cards render. After Session 3, confirm status colors update each poll cycle; with poller off, confirm placeholders or “no data yet” behavior.

---

### Session 6 — Final wiring + smoke (~15k tokens)

No external API spec required.

| Agent | Model | Files | Est. Tokens |
|-------|-------|-------|-------------|
| 6A: Entry + env validation | Sonnet | `src/index.ts`, `.env.example` | ~15k |

**Dependencies:** Sessions 4 and 5 complete (or workable MVP).
**Verification:** Single process: dashboard + poller + MCP stdio; CSV import; live poll. Confirm docs/env list **no** Sync Cloud, **no** Datadog.

---

## Parallel Work Summary

```
Session 1: [1A scaffold] [1B database] [1C csv]  ← 3 parallel Haiku agents (1C after 1B API)
Session 2: [2A local-api]                          ← 1 Sonnet agent (spec-heavy)
Session 3: [3A poller]                             ← 1 agent
Session 4: [4A mcp]                                ← 1 Sonnet agent
Session 5: [5A dash-api] [5B dash-ui]             ← 2 parallel agents (can run alongside Session 4)
Session 6: [6A entry-point]                       ← polish + smoke (CollabOS-only)
```

**Sessions 4 and 5 can run in parallel** — they share only the DB layer (read interface), and that's already defined by Session 1B.

---

## Verification Checklist

- [ ] Session 1: DB initializes, CSV import populates `devices` table
- [ ] Session 2: All 4 CollabOS API endpoints return data from a live device
- [ ] Session 3: Poller runs 2+ cycles, SQLite state updates
- [ ] Session 4: MCP tools work in Claude Desktop (`list_rooms`, `get_room_status`, `refresh_device`, etc.)
- [ ] Session 5: Dashboard shows room cards, CSV upload works; with poller running, status matches SQLite / stale rules
- [ ] Session 6: Full CollabOS-only smoke test; docs and env list no Sync Cloud

---

## Critical Files

- `.cursor/mcp.json` — Cursor MCP: LogiSync + zoom-mcp side by side
- `README.md` — build, env, dual-MCP setup
- `device-management-api.yaml` — local CollabOS OpenAPI spec (agent for Session 2 must read this)
- `src/db/store.ts` — all persistence; completed in Session 1B, referenced by all later sessions
- `src/devices/local-api.ts` — primary data source; completed in Session 2, used by Session 3A
- `src/devices/poller.ts` — fleet polling; must implement concurrency, timeouts, jitter (see Background poller)
- `src/mcp/server.ts` — primary AI interface (read + refresh only)
