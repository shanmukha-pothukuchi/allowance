/**
 * Computer-use settings (docs/ARCHITECTURE.md §19.1). The shared fields (DATA_DIR, facilitator, chain
 * mode) come from `loadConfig()`; the computer's own come from COMPUTER_USE_* variables, named the
 * way `quantcommBridgePort`/`quantcommBridgeUrl` are so they can move into AppConfig unchanged.
 */
import { loadConfig, type AppConfig } from "@allowance/shared";

export const DEFAULT_COMPUTER_USE_PORT = 4090;
export const DEFAULT_IMAGE = "allowance-cu-desktop:latest";

export interface ComputerUseConfig extends Pick<AppConfig, "dataDir" | "x402FacilitatorUrl" | "chainMode" | "facilitatorUrl"> {
  /** COMPUTER_USE_PORT (4090). */
  computerUsePort: number;
  /** COMPUTER_USE_URL, the public base agents call (default http://localhost:<port>). */
  computerUseUrl: string;
  /** COMPUTER_USE_SEATS: desktops that run at once (default 1). */
  computerUseSeats: number;
  /** COMPUTER_USE_MAX_QUEUE: waiting sessions before new ones are refused (default 20). */
  computerUseMaxQueue: number;
  /** COMPUTER_USE_START_GRACE_SECONDS: time to buy the first minute once a seat is yours (default 90). */
  computerUseStartGraceSeconds: number;
  /** COMPUTER_USE_MAX_SESSION_MINUTES: longest paid session (default 30). */
  computerUseMaxSessionMinutes: number;
  /** COMPUTER_USE_MAX_LEASE_AHEAD_MINUTES: most prepaid time a lease can hold (default 10). */
  computerUseMaxLeaseAheadMinutes: number;
  docker: {
    /** COMPUTER_USE_IMAGE */
    image: string;
    /** COMPUTER_USE_CPUS (1) */
    cpus: string;
    /** COMPUTER_USE_MEMORY (1g) */
    memory: string;
    /** COMPUTER_USE_DNS (comma list, default 1.1.1.1,8.8.8.8): public resolvers, so the firewall never needs a LAN one. */
    dns: string[];
    /** COMPUTER_USE_ACCESS: "ip" (talk to the container's bridge IP; Linux) or "publish" (a 127.0.0.1 port; Docker Desktop). */
    access: "ip" | "publish";
  };
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function loadComputerUseConfig(env: NodeJS.ProcessEnv = process.env, base: AppConfig = loadConfig()): ComputerUseConfig {
  const port = int(env.COMPUTER_USE_PORT, DEFAULT_COMPUTER_USE_PORT, 1, 65535);
  const url = (env.COMPUTER_USE_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, "");
  const dns = (env.COMPUTER_USE_DNS ?? "1.1.1.1,8.8.8.8")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f.:]+$/i.test(s));
  return {
    dataDir: base.dataDir,
    x402FacilitatorUrl: base.x402FacilitatorUrl,
    chainMode: base.chainMode,
    facilitatorUrl: base.facilitatorUrl,
    computerUsePort: port,
    computerUseUrl: url,
    computerUseSeats: int(env.COMPUTER_USE_SEATS, 1, 1, 16),
    computerUseMaxQueue: int(env.COMPUTER_USE_MAX_QUEUE, 20, 0, 500),
    computerUseStartGraceSeconds: int(env.COMPUTER_USE_START_GRACE_SECONDS, 90, 5, 600),
    computerUseMaxSessionMinutes: int(env.COMPUTER_USE_MAX_SESSION_MINUTES, 30, 1, 240),
    computerUseMaxLeaseAheadMinutes: int(env.COMPUTER_USE_MAX_LEASE_AHEAD_MINUTES, 10, 1, 60),
    docker: {
      image: env.COMPUTER_USE_IMAGE?.trim() || DEFAULT_IMAGE,
      cpus: /^\d+(\.\d+)?$/.test(env.COMPUTER_USE_CPUS ?? "") ? env.COMPUTER_USE_CPUS! : "1",
      memory: /^\d+[kmg]$/i.test(env.COMPUTER_USE_MEMORY ?? "") ? env.COMPUTER_USE_MEMORY! : "1g",
      dns: dns.length ? dns : ["1.1.1.1", "8.8.8.8"],
      access: env.COMPUTER_USE_ACCESS === "publish" ? "publish" : "ip",
    },
  };
}
