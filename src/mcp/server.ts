import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  listRoomsSummary,
  listOfflineOrStale,
  getDevice,
  getDeviceState,
  listDevices,
} from "../db/store.js";
import { importZoomCsv } from "../devices/registry.js";
import type { CollabOsClient, PollSnapshot } from "../devices/local-api.js";
import { pollOneDevice } from "../devices/poller.js";
import { config } from "../config.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function parseSnapshot(raw: string | null): PollSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PollSnapshot;
  } catch {
    return null;
  }
}

export async function startMcpServer(db: Database.Database, client: CollabOsClient): Promise<void> {
  const server = new McpServer({
    name: "logisync-mcp",
    version: "0.1.0",
  });

  server.registerTool("list_rooms", { description: "All active rooms with cached status summary" }, async () => {
    const now = Date.now();
    const staleMs = config.offlineStaleSeconds * 1000;
    const rooms = listRoomsSummary(db, staleMs, now);
    return jsonResult({ rooms });
  });

  server.registerTool(
    "get_room_status",
    {
      description: "Full cached status for a room (match Assignment/room name or device serial)",
      inputSchema: { query: z.string().describe("Room name substring or device serial number") },
    },
    async ({ query }) => {
      const q = query.trim().toLowerCase();
      const devices = listDevices(db, true).filter(
        (d) =>
          d.id.toLowerCase() === q ||
          d.room_name.toLowerCase() === q ||
          d.room_name.toLowerCase().includes(q),
      );
      if (devices.length === 0) {
        return jsonResult({ error: "No matching device", query });
      }
      const out = devices.map((d) => {
        const st = getDeviceState(db, d.id);
        const snap = parseSnapshot(st?.raw_json ?? null);
        return {
          device: d,
          state: st,
          snapshot: snap,
        };
      });
      return jsonResult({ matches: out });
    },
  );

  server.registerTool(
    "get_device_config",
    {
      description: "Cached device hardware/config from last CollabOS poll (/api/v1/device)",
      inputSchema: { device_id: z.string() },
    },
    async ({ device_id }) => {
      const st = getDeviceState(db, device_id);
      const snap = parseSnapshot(st?.raw_json ?? null);
      const dev = getDevice(db, device_id);
      if (!dev) return jsonResult({ error: "Unknown device_id" });
      return jsonResult({ device: dev, collab_os_device: snap?.device ?? null, polled_at: st?.polled_at });
    },
  );

  server.registerTool(
    "get_peripherals",
    {
      description: "Cached peripherals from last poll (/api/v1/peripherals)",
      inputSchema: { device_id: z.string() },
    },
    async ({ device_id }) => {
      const st = getDeviceState(db, device_id);
      const snap = parseSnapshot(st?.raw_json ?? null);
      if (!getDevice(db, device_id)) return jsonResult({ error: "Unknown device_id" });
      return jsonResult({ peripherals: snap?.peripherals ?? null, polled_at: st?.polled_at });
    },
  );

  server.registerTool(
    "list_offline_devices",
    {
      description:
        "Devices never polled, stale (no successful poll within threshold), or offline on last poll",
    },
    async () => {
      const now = Date.now();
      const staleMs = config.offlineStaleSeconds * 1000;
      const items = listOfflineOrStale(db, staleMs, now);
      return jsonResult({ offline_or_stale: items, stale_seconds: config.offlineStaleSeconds });
    },
  );

  server.registerTool(
    "import_devices",
    {
      description:
        "Import Zoom device CSV. Prefer csv_path (absolute path on server). Optional csv_inline for small files.",
      inputSchema: {
        csv_path: z.string().optional().describe("Absolute path to CSV file on the host running MCP"),
        csv_inline: z.string().optional().describe("Raw CSV content (avoid huge pastes)"),
      },
    },
    async ({ csv_path, csv_inline }) => {
      let text: string | undefined;
      if (csv_path) {
        const abs = resolve(csv_path);
        if (!existsSync(abs)) return jsonResult({ error: "File not found", path: abs });
        text = readFileSync(abs, "utf8");
      } else if (csv_inline) {
        text = csv_inline;
      } else {
        return jsonResult({ error: "Provide csv_path or csv_inline" });
      }
      const r = importZoomCsv(db, text);
      return jsonResult({ ok: true, imported: r.imported, skipped: r.skipped });
    },
  );

  server.registerTool(
    "refresh_device",
    {
      description: "Force immediate CollabOS poll for one device (requires COLLAB_OS_PASSWORD)",
      inputSchema: { device_id: z.string() },
    },
    async ({ device_id }) => {
      if (!config.collabOsPassword) {
        return jsonResult({ error: "COLLAB_OS_PASSWORD not set" });
      }
      const dev = getDevice(db, device_id);
      if (!dev || !dev.active) return jsonResult({ error: "Unknown or inactive device_id" });
      await pollOneDevice(db, client, device_id, dev.ip_address);
      const st = getDeviceState(db, device_id);
      return jsonResult({ ok: true, device_id, state: st });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
