import express, { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { importZoomCsv } from "../devices/registry.js";
import { listRoomsSummary, listDevices } from "../db/store.js";
import { config } from "../config.js";
import type { CollabOsClient } from "../devices/local-api.js";
import { pollOneDevice } from "../devices/poller.js";

/** API-only router (mount at `/api` from `index.ts`). Static files are served separately. */
export function createApiRouter(db: Database.Database, client: CollabOsClient): Router {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  router.get("/rooms", (_req: Request, res: Response) => {
    const now = Date.now();
    const staleMs = config.offlineStaleSeconds * 1000;
    const rooms = listRoomsSummary(db, staleMs, now);
    res.json({ rooms });
  });

  router.get("/devices", (_req: Request, res: Response) => {
    res.json({ devices: listDevices(db, true) });
  });

  router.post(
    "/import",
    express.text({ type: ["text/csv", "text/plain", "application/octet-stream", "*/*"], limit: "20mb" }),
    (req: Request, res: Response) => {
      try {
        const body = typeof req.body === "string" ? req.body : "";
        if (!body.trim()) {
          res.status(400).json({ error: "Expected CSV body" });
          return;
        }
        const r = importZoomCsv(db, body);
        res.json({ ok: true, imported: r.imported, skipped: r.skipped });
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  router.post("/refresh/:deviceId", async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    if (!deviceId) {
      res.status(400).json({ error: "deviceId required" });
      return;
    }
    if (!config.collabOsPassword) {
      res.status(503).json({ error: "COLLAB_OS_PASSWORD not configured" });
      return;
    }
    const devs = listDevices(db, true).find((d) => d.id === deviceId);
    if (!devs) {
      res.status(404).json({ error: "Device not found or inactive" });
      return;
    }
    try {
      await pollOneDevice(db, client, deviceId, devs.ip_address);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.get("/import-sample-path", (req: Request, res: Response) => {
    const p = typeof req.query.path === "string" ? req.query.path : "";
    if (!p) {
      res.status(400).json({ error: "Query ?path= absolute path to CSV required" });
      return;
    }
    const abs = resolve(p);
    if (!existsSync(abs)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    try {
      const text = readFileSync(abs, "utf8");
      const r = importZoomCsv(db, text);
      res.json({ ok: true, imported: r.imported, skipped: r.skipped, path: abs });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}
