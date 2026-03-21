import { createAppServer } from "./app-server.js";
import { loadConfig } from "./config.js";
import { ensureDownloadDir, cleanupDownloads } from "./download.js";
import { createSafeProxyServer } from "./proxy.js";

const config = loadConfig();
const safeProxy = await createSafeProxyServer();

await ensureDownloadDir(config);
await cleanupDownloads(config);

const { close, server } = createAppServer({
  config,
  proxyUrl: safeProxy.url
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

process.on("exit", () => {
  safeProxy.close();
});

process.on("SIGINT", async () => {
  await close().catch(() => {
    return;
  });
  safeProxy.close();
  process.exit(0);
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`Listening on http://${config.server.host}:${config.server.port}`);
});
