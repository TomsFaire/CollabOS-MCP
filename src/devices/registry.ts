import { parse } from "csv-parse/sync";
import type Database from "better-sqlite3";
import {
  upsertDevice,
  markAbsentDevices,
  upsertDeviceState,
  getDeviceState,
  type DeviceStateRow,
} from "../db/store.js";

export type ZoomCsvRow = Record<string, string>;

function norm(s: string): string {
  return s?.trim() ?? "";
}

function officeFromAssignment(assignment: string): string | null {
  const a = norm(assignment);
  if (!a) return null;
  const dash = a.indexOf("-");
  if (dash <= 0) return a.slice(0, 8) || null;
  return a.slice(0, dash) || null;
}

function zoomStatusToBootstrapOnline(status: string): number {
  const s = norm(status).toLowerCase();
  if (s === "offline") return 0;
  if (s === "online" || s.includes("meeting")) return 1;
  return 0;
}

function normalizeMac(mac: string): string | null {
  const m = norm(mac);
  return m === "" || m === "-" ? null : m.replace(/-/g, ":").toUpperCase();
}

export function parseZoomDevicesCsv(csvText: string): ZoomCsvRow[] {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  }) as ZoomCsvRow[];
  return records;
}

export function importZoomCsv(db: Database.Database, csvText: string, now = Date.now()): {
  imported: number;
  skipped: number;
  presentIds: string[];
} {
  const rows = parseZoomDevicesCsv(csvText);
  let skipped = 0;
  const presentIds: string[] = [];

  const tx = db.transaction(() => {
    for (const row of rows) {
      const vendor = norm(row["Vendor"] ?? row["vendor"] ?? "");
      const serial = norm(row["Serial Number"] ?? row["SerialNumber"] ?? "");
      if (vendor.toLowerCase() !== "logitech" || !serial || serial === "-" || serial === "—") {
        skipped++;
        continue;
      }

      const assignment = norm(row["Assignment"] ?? "");
      const ip = norm(row["IP Address"] ?? row["IPAddress"] ?? "");
      if (!ip) {
        skipped++;
        continue;
      }

      const roomName = assignment || norm(row["Device Name"] ?? "") || serial;
      const model = norm(row["Model"] ?? "") || null;
      const firmware = norm(row["Platform OS Version"] ?? "") || null;
      const mac = normalizeMac(row["MAC Address"] ?? "");
      const office = officeFromAssignment(assignment);

      upsertDevice(db, {
        id: serial,
        room_name: roomName,
        ip_address: ip,
        model_name: model,
        firmware_version: firmware,
        mac_address: mac,
        office,
      });
      presentIds.push(serial);

      const status = norm(row["Status"] ?? "");
      const existing = getDeviceState(db, serial);
      if (!existing || existing.polled_at == null) {
        const online = zoomStatusToBootstrapOnline(status);
        upsertDeviceState(db, {
          device_id: serial,
          polled_at: existing?.polled_at ?? null,
          online,
          device_state: existing?.device_state ?? null,
          mic_state: existing?.mic_state ?? null,
          speaker_state: existing?.speaker_state ?? null,
          speaker_volume: existing?.speaker_volume ?? null,
          occupancy_count: existing?.occupancy_count ?? null,
          presence: existing?.presence ?? null,
          co2: existing?.co2 ?? null,
          temp: existing?.temp ?? null,
          humidity: existing?.humidity ?? null,
          tvoc: existing?.tvoc ?? null,
          pm25: existing?.pm25 ?? null,
          pm10: existing?.pm10 ?? null,
          pressure: existing?.pressure ?? null,
          raw_json: existing?.raw_json ?? null,
        });
      }
    }

    markAbsentDevices(db, new Set(presentIds), now);
  });

  tx();

  return { imported: presentIds.length, skipped, presentIds };
}
