import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (parent of `src/` or `dist/`), stable when MCP is spawned with a non-repo cwd. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function envString(key: string, defaultValue: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : defaultValue;
}

function envInt(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function loadDotEnv(): void {
  const roots = [...new Set([process.cwd(), packageRoot()])];
  for (const root of roots) {
    for (const name of [".env", ".env.local"]) {
      const p = resolve(root, name);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[k] === undefined) process.env[k] = val;
      }
    }
  }
}

loadDotEnv();

const pollIntervalSec = envInt("POLL_INTERVAL_SECONDS", 60);
const offlineStaleSeconds = envInt(
  "OFFLINE_STALE_SECONDS",
  Math.max(300, 2 * pollIntervalSec),
);

export const config = {
  pollIntervalSeconds: pollIntervalSec,
  pollConcurrency: envInt("POLL_CONCURRENCY", 8),
  pollPerDeviceTimeoutMs: envInt("POLL_PER_DEVICE_TIMEOUT_MS", 12_000),
  pollJitterMsMax: envInt("POLL_JITTER_MS_MAX", 3000),
  offlineStaleSeconds,
  dashboardPort: envInt("DASHBOARD_PORT", 3000),
  databasePath: (() => {
    const raw = envString("DATABASE_PATH", "./data/logisync.db");
    return raw.startsWith("/") ? raw : resolve(packageRoot(), raw);
  })(),

  collabOsUsername: envString("COLLAB_OS_USERNAME", "admin"),
  collabOsPassword: envString("COLLAB_OS_PASSWORD", ""),
  collabOsTlsInsecure: envBool("COLLAB_OS_TLS_INSECURE", true),

  disableMcp: envBool("DISABLE_MCP", false),
  disablePoller: envBool("DISABLE_POLLER", false),
  disableDashboard: envBool("DISABLE_DASHBOARD", false),
};
