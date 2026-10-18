/**
 * `npm run computer-use:image`: build the desktop image now (the service also builds it on start
 * when it is missing or its docker/ files changed).
 */
import { fileURLToPath } from "node:url";
import { loadComputerUseConfig } from "./config.js";
import { ensureImage } from "./docker.js";

const config = loadComputerUseConfig();
const contextDir = fileURLToPath(new URL("../docker", import.meta.url));
const status = await ensureImage(config.docker.image, contextDir, (m) => console.log(`[computer-use] ${m}`), () => {});
if (status === "ready") console.log(`[computer-use] ${config.docker.image} is ready`);
process.exit(status === "ready" ? 0 : 1);
