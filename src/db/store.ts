import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type DeviceRow = {
  id: string;
  room_name: string;
  ip_address: string;
  model_name: string | null;
  firmware_version: string | null;
  mac_address: string | null;
  office: string | null;
  active: number;
  removed_from_import_at: number | null;
  last_seen_at: number | null;
};

export type DeviceStateRow = {
  device_id: string;
  polled_at: number | null;
  online: number;
  device_state: string | null;
  mic_state: string | null;
  speaker_state: string | null;
  speaker_volume: number | null;
  occupancy_count: number | null;
  presence: string | null;
  co2: number | null;
  temp: number | null;
  humidity: number | null;
  tvoc: number | null;
  pm25: number | null;
  pm10: number | null;
  pressure: number | null;
  raw_json: string | null;
};

let _db: Database.Database | null = null;

export function openDatabase(path: string, readonly = false): Database.Database {
  const dir = dirname(path);
  if (!readonly && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(path, { readonly });
  if (!readonly) initSchema(db);
  return db;
}

export function getDb(path: string, readonly = false): Database.Database {
  if (_db) return _db;
  _db = openDatabase(path, readonly);
  return _db;
}

export function setDb(db: Database.Database | null): void {
  _db = db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      model_name TEXT,
      firmware_version TEXT,
      mac_address TEXT,
      office TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      removed_from_import_at INTEGER,
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS device_states (
      device_id TEXT PRIMARY KEY REFERENCES devices(id),
      polled_at INTEGER,
      online INTEGER NOT NULL DEFAULT 0,
      device_state TEXT,
      mic_state TEXT,
      speaker_state TEXT,
      speaker_volume INTEGER,
      occupancy_count INTEGER,
      presence TEXT,
      co2 REAL,
      temp REAL,
      humidity REAL,
      tvoc REAL,
      pm25 REAL,
      pm10 REAL,
      pressure REAL,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(active);
  `);
}

const upsertDeviceStmt = (db: Database.Database) =>
  db.prepare(`
    INSERT INTO devices (id, room_name, ip_address, model_name, firmware_version, mac_address, office, active, removed_from_import_at)
    VALUES (@id, @room_name, @ip_address, @model_name, @firmware_version, @mac_address, @office, 1, NULL)
    ON CONFLICT(id) DO UPDATE SET
      room_name = excluded.room_name,
      ip_address = excluded.ip_address,
      model_name = excluded.model_name,
      firmware_version = excluded.firmware_version,
      mac_address = excluded.mac_address,
      office = excluded.office,
      active = 1,
      removed_from_import_at = NULL
  `);

export function upsertDevice(
  db: Database.Database,
  row: Omit<DeviceRow, "active" | "removed_from_import_at" | "last_seen_at">,
): void {
  upsertDeviceStmt(db).run(row);
}

export function markAbsentDevices(db: Database.Database, presentIds: Set<string>, now: number): void {
  const rows = db.prepare(`SELECT id FROM devices WHERE active = 1`).all() as { id: string }[];
  const tx = db.transaction(() => {
    for (const { id } of rows) {
      if (!presentIds.has(id)) {
        db.prepare(
          `UPDATE devices SET active = 0, removed_from_import_at = ? WHERE id = ?`,
        ).run(now, id);
      }
    }
  });
  tx();
}

export function listDevices(db: Database.Database, activeOnly = true): DeviceRow[] {
  const sql = activeOnly
    ? `SELECT * FROM devices WHERE active = 1 ORDER BY room_name`
    : `SELECT * FROM devices ORDER BY active DESC, room_name`;
  return db.prepare(sql).all() as DeviceRow[];
}

export function getDevice(db: Database.Database, id: string): DeviceRow | undefined {
  return db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined;
}

export function hardDeleteDevice(db: Database.Database, id: string): boolean {
  const r = db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
  return r.changes > 0;
}

export function upsertDeviceState(db: Database.Database, row: DeviceStateRow): void {
  db.prepare(
    `
    INSERT INTO device_states (
      device_id, polled_at, online, device_state, mic_state, speaker_state, speaker_volume,
      occupancy_count, presence, co2, temp, humidity, tvoc, pm25, pm10, pressure, raw_json
    ) VALUES (
      @device_id, @polled_at, @online, @device_state, @mic_state, @speaker_state, @speaker_volume,
      @occupancy_count, @presence, @co2, @temp, @humidity, @tvoc, @pm25, @pm10, @pressure, @raw_json
    )
    ON CONFLICT(device_id) DO UPDATE SET
      polled_at = excluded.polled_at,
      online = excluded.online,
      device_state = excluded.device_state,
      mic_state = excluded.mic_state,
      speaker_state = excluded.speaker_state,
      speaker_volume = excluded.speaker_volume,
      occupancy_count = excluded.occupancy_count,
      presence = excluded.presence,
      co2 = excluded.co2,
      temp = excluded.temp,
      humidity = excluded.humidity,
      tvoc = excluded.tvoc,
      pm25 = excluded.pm25,
      pm10 = excluded.pm10,
      pressure = excluded.pressure,
      raw_json = excluded.raw_json
  `,
  ).run(row);
}

export function updateDeviceLastSeen(db: Database.Database, deviceId: string, at: number): void {
  db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(at, deviceId);
}

export function getDeviceState(db: Database.Database, deviceId: string): DeviceStateRow | undefined {
  return db
    .prepare(`SELECT * FROM device_states WHERE device_id = ?`)
    .get(deviceId) as DeviceStateRow | undefined;
}

export function listDeviceStates(db: Database.Database): DeviceStateRow[] {
  return db.prepare(`SELECT * FROM device_states`).all() as DeviceStateRow[];
}

export function listRoomsSummary(
  db: Database.Database,
  staleAfterMs: number,
  now: number,
): {
  device_id: string;
  room_name: string;
  office: string | null;
  ip_address: string;
  online: number;
  polled_at: number | null;
  stale: boolean;
  never_polled: boolean;
  device_state: string | null;
  occupancy_count: number | null;
}[] {
  const rows = db
    .prepare(
      `
    SELECT d.id as device_id, d.room_name, d.office, d.ip_address,
           COALESCE(s.online, 0) as online, s.polled_at, s.device_state, s.occupancy_count
    FROM devices d
    LEFT JOIN device_states s ON s.device_id = d.id
    WHERE d.active = 1
    ORDER BY d.room_name
  `,
    )
    .all() as {
    device_id: string;
    room_name: string;
    office: string | null;
    ip_address: string;
    online: number;
    polled_at: number | null;
    device_state: string | null;
    occupancy_count: number | null;
  }[];

  return rows.map((r) => {
    const never = r.polled_at == null;
    const stale = never || (r.polled_at != null && now - r.polled_at > staleAfterMs);
    return { ...r, stale, never_polled: never };
  });
}

export function listOfflineOrStale(
  db: Database.Database,
  staleAfterMs: number,
  now: number,
): { device_id: string; room_name: string; reason: string }[] {
  const summary = listRoomsSummary(db, staleAfterMs, now);
  const out: { device_id: string; room_name: string; reason: string }[] = [];
  for (const r of summary) {
    if (r.never_polled) {
      out.push({ device_id: r.device_id, room_name: r.room_name, reason: "never_polled" });
      continue;
    }
    if (r.stale) {
      out.push({ device_id: r.device_id, room_name: r.room_name, reason: "stale" });
      continue;
    }
    if (!r.online) {
      out.push({ device_id: r.device_id, room_name: r.room_name, reason: "offline_last_poll" });
    }
  }
  return out;
}
