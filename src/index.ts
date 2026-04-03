import { config } from "./config.js";
import { openDatabase } from "./db/store.js";
import { CollabOsClient } from "./devices/local-api.js";
import { startPoller } from "./devices/poller.js";
import { createApiRouter } from "./dashboard/router.js";
import { startMcpServer } from "./mcp/server.js";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const log = (msg: string) => {
  console.error(`[logisync] ${msg}`);
};

async function main(): Promise<void> {
  const db = openDatabase(config.databasePath, false);
  const client = new CollabOsClient(
    config.collabOsUsername,
    config.collabOsPassword,
    config.collabOsTlsInsecure,
  );

  if (!config.disablePoller) {
    startPoller(db, client, log);
  }

  if (!config.disableDashboard) {
    const app = express();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const publicDir = join(__dirname, "dashboard/public");
    app.use(express.json({ limit: "2mb" }));
    app.use("/api", createApiRouter(db, client));
    app.use(express.static(publicDir));

    await new Promise<void>((resolve, reject) => {
      const srv = app.listen(config.dashboardPort, () => {
        log(`dashboard http://127.0.0.1:${config.dashboardPort}/`);
        resolve();
      });
      srv.on("error", reject);
    });
  }

  if (!config.disableMcp) {
    await startMcpServer(db, client);
  } else {
    log("MCP disabled (DISABLE_MCP=1); holding process for poller/dashboard.");
    await new Promise<void>(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
