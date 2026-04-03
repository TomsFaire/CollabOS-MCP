# LogiSync MCP

CollabOS LAN polling, SQLite cache, optional dashboard, and an MCP server so Cursor models can read Logitech room/device status (and refresh polls on demand). See `logipcmplan.md` for the full design.

## Prerequisites

- Node.js 18+
- `npm install` and `npm run build`
- CollabOS admin credentials (`COLLAB_OS_USERNAME` / `COLLAB_OS_PASSWORD`) for polling
- Optional: [zoom-mcp](https://github.com/echelon-ai-labs/zoom-mcp) cloned **next to this repo** as `../zoom-mcp` (for Cursor dual-MCP setup)

## Setup

1. Copy `.env.example` to `.env` and fill in secrets (never commit `.env`). Older templates may have Datadog keys — you can remove them; this build does not send metrics anywhere except SQLite + MCP.
2. `npm install`
3. `npm run build`
4. Import devices: dashboard **Import Zoom CSV** or MCP tool `import_devices`. Keep Zoom exports (e.g. `Zoom*.csv`) **outside git** — they are listed in `.gitignore` and must not be pushed.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript to `dist/` (run after code changes; required before MCP uses `dist/index.js`) |
| `npm start` | Run dashboard + poller + MCP stdio (normal server process) |
| `npm run dev` | `tsx watch src/index.ts` for development |
| `npm run mcp` | Same as `npm start` (entry is `dist/index.js`) |

## Cursor: both MCP servers

This repo includes **`.cursor/mcp.json`**, which registers:

1. **logisync** — this project (`node dist/index.js`). Loads `.env` from the repo root even if Cursor uses a different process cwd.
2. **zoom** — [echelon-ai-labs/zoom-mcp](https://github.com/echelon-ai-labs/zoom-mcp), expected at **`../zoom-mcp`** relative to this workspace, launched with **`uv run zoom-mcp`**.

### One-time: clone and install Zoom MCP

From the parent of `logisync-mcp` (e.g. `~/Documents/Claude`):

```bash
git clone https://github.com/echelon-ai-labs/zoom-mcp.git zoom-mcp
cd zoom-mcp
uv venv && source .venv/bin/activate   # or your preferred venv
uv pip install -e .
cp .env.example .env
# Add ZOOM_API_KEY, ZOOM_API_SECRET, ZOOM_ACCOUNT_ID per zoom-mcp README
```

Ensure `uv` is on your `PATH` (or change `.cursor/mcp.json` to use the full path to `uv`, or replace the `zoom` block with `python3` + `-m zoom_mcp.cli` after `pip install -e .`).

### Enable in Cursor

1. Confirm **`npm run build`** has been run so `dist/index.js` exists.
2. Open **Cursor Settings → MCP** (or rely on project `.cursor/mcp.json` if your Cursor version loads it).
3. If `${workspaceFolder}` is not expanded, edit `.cursor/mcp.json` and replace those segments with the **absolute** path to this repo and to `zoom-mcp`.
4. **Fully quit and restart Cursor** after changing MCP config.

### Optional: MCP-only (no dashboard port)

Set in `.cursor/mcp.json` under `logisync.env`:

```json
"DISABLE_DASHBOARD": "1"
```

Or keep the dashboard on `DASHBOARD_PORT` (default 3000) for the same process.

## MCP tools (LogiSync)

`list_rooms`, `get_room_status`, `get_device_config`, `get_peripherals`, `list_offline_devices`, `import_devices`, `refresh_device`.

## License

Private / internal unless you add a license file.
