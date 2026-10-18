/**
 * Computer use service entrypoint (docs/ARCHITECTURE.md §19). `npm run dev:computer-use`.
 * Builds the desktop image in the background when it is missing or out of date, removes desktops a
 * previous run of this service left behind, and removes every desktop it started when it stops.
 */
import { fileURLToPath } from "node:url";
import { createComputerUseApp } from "./app.js";
import { loadComputerUseConfig } from "./config.js";
import { DockerDesktopDriver, ensureImage, type ImageStatus } from "./docker.js";

export { createComputerUseApp, DIRECTORY_NAME, SUMMARY, type ComputerUseApp, type ComputerUseDeps } from "./app.js";
export { loadComputerUseConfig, type ComputerUseConfig } from "./config.js";
export { DockerDesktopDriver, CONTAINER_PREFIX } from "./docker.js";
export * from "./prices.js";

const LOG = "[computer-use]";
const isMain = process.argv[1] && /computer-use[\\/]src[\\/]index\.ts$/.test(process.argv[1]);

if (isMain) {
  const config = loadComputerUseConfig();
  const log = (m: string) => console.log(`${LOG} ${m}`);
  let imageStatus: ImageStatus = "missing";
  const driver = new DockerDesktopDriver({
    ...config.docker,
    instance: String(config.computerUsePort),
    log,
    imageStatus: () => imageStatus,
  });
  await driver.cleanup(); // leftovers of a previous run of this service (same port)
  const contextDir = fileURLToPath(new URL("../docker", import.meta.url));
  void ensureImage(config.docker.image, contextDir, log, (s) => (imageStatus = s));

  const app = createComputerUseApp(config, { driver });
  const server = app.listen(config.computerUsePort, () => {
    log(`computer on ${config.computerUseUrl}/computer (${config.computerUseSeats} seat${config.computerUseSeats === 1 ? "" : "s"}, earnings wallet ${app.locals.payTo})`);
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 20_000).unref();
    server.close();
    server.closeAllConnections?.();
    try {
      await app.locals.shutdown();
      log("removed every desktop; bye");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
