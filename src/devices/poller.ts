import type Database from "better-sqlite3";
import { CollabOsClient, pollDeviceFull, type PollSnapshot } from "./local-api.js";
import {
  upsertDeviceState,
  updateDeviceLastSeen,
  listDevices,
  type DeviceStateRow,
} from "../db/store.js";
import { config } from "../config.js";

function jitterMs(): number {
  const max = config.pollJitterMsMax;
  if (max <= 0) return 0;
  return Math.floor(Math.random() * max);
}

function snapshotToStateRow(deviceId: string, snapshot: PollSnapshot, online: number): DeviceStateRow {
  const room = snapshot.room as
    | {
        occupancyCount?: number;
        environmentalData?: {
          co2?: number;
          temp?: number;
          relativeHumidity?: number;
          tvoc?: number;
          pm25?: number;
          pm10?: number;
          pressure?: number;
          presence?: string;
        };
      }
    | null
    | undefined;

  const env = room?.environmentalData;
  const di = snapshot.deviceInsights;

  return {
    device_id: deviceId,
    polled_at: Date.now(),
    online,
    device_state: di?.deviceState != null ? String(di.deviceState) : null,
    mic_state: di?.micState != null ? String(di.micState) : null,
    speaker_state: di?.speakerState != null ? String(di.speakerState) : null,
    speaker_volume:
      typeof di?.speakerVolume === "number" ? di.speakerVolume : null,
    occupancy_count: typeof room?.occupancyCount === "number" ? room.occupancyCount : null,
    presence: env?.presence != null ? String(env.presence) : null,
    co2: env?.co2 ?? null,
    temp: env?.temp ?? null,
    humidity: env?.relativeHumidity ?? null,
    tvoc: env?.tvoc ?? null,
    pm25: env?.pm25 ?? null,
    pm10: env?.pm10 ?? null,
    pressure: env?.pressure ?? null,
    raw_json: JSON.stringify(snapshot),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  }
  const n = Math.min(concurrency, items.length) || 1;
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function pollOneDevice(
  db: Database.Database,
  client: CollabOsClient,
  deviceId: string,
  ip: string,
): Promise<void> {
  const result = await pollDeviceFull(client, ip, config.pollPerDeviceTimeoutMs);
  const now = Date.now();
  if (result.ok) {
    const row = snapshotToStateRow(deviceId, result.snapshot, 1);
    upsertDeviceState(db, row);
    updateDeviceLastSeen(db, deviceId, now);
  } else {
    upsertDeviceState(db, {
      device_id: deviceId,
      polled_at: now,
      online: 0,
      device_state: null,
      mic_state: null,
      speaker_state: null,
      speaker_volume: null,
      occupancy_count: null,
      presence: null,
      co2: null,
      temp: null,
      humidity: null,
      tvoc: null,
      pm25: null,
      pm10: null,
      pressure: null,
      raw_json: JSON.stringify(result.snapshot),
    });
  }
}

export function startPoller(
  db: Database.Database,
  client: CollabOsClient,
  log: (msg: string) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (!config.collabOsPassword) {
      log("poller: COLLAB_OS_PASSWORD not set, skipping cycle");
      schedule();
      return;
    }

    const devices = listDevices(db, true);
    await mapPool(devices, config.pollConcurrency, async (d) => {
      try {
        await pollOneDevice(db, client, d.id, d.ip_address);
      } catch (e) {
        log(`poller: ${d.id} ${e instanceof Error ? e.message : e}`);
      }
    });

    schedule();
  };

  const schedule = () => {
    if (stopped) return;
    const delay = config.pollIntervalSeconds * 1000 + jitterMs();
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  timer = setTimeout(() => {
    void tick();
  }, jitterMs());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
