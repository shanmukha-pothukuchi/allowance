/**
 * Desktops as Docker containers (docs/ARCHITECTURE.md §19.4), driven with the `docker` CLI (no shell,
 * fixed argument lists). One fresh container per session, named allowance-cu-<session id>, removed
 * when the session ends and when the service stops.
 *
 * Isolation, per container:
 * - no mounts, not privileged, no Docker socket, read-only root, tmpfs /tmp and /run only;
 * - every capability dropped except NET_ADMIN/SETUID/SETGID, which the entrypoint uses to install
 *   the egress firewall and switch to an unprivileged user (which clears them) before anything runs;
 * - no-new-privileges, a pid limit, CPU and memory limits (no swap), small logs;
 * - IPv6 off, public DNS; the firewall blocks the host, the LAN, other containers and loopback;
 * - the control server needs a random per-container secret.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DesktopError, type ActionRequest, type ActionResult, type Desktop, type DesktopDriver, type TextSnapshot } from "./desktop.js";

export const CONTAINER_PREFIX = "allowance-cu-";
export const LABEL = "allowance.cu";
const CONTROL_PORT = 8080;

export interface DockerDriverOptions {
  image: string;
  cpus: string;
  memory: string;
  dns: string[];
  access: "ip" | "publish";
  /** Marks this service instance's containers (e.g. "4090"), so a restart can remove its own leftovers only. */
  instance: string;
  log?: (msg: string) => void;
  /** How long a desktop may take to come up (default 45 s). */
  startTimeoutMs?: number;
  /** While the image is being built, check() says so. */
  imageStatus?: () => "ready" | "building" | "missing" | "failed";
}

export function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim().split("\n").slice(-3).join(" ");
        reject(new Error(msg || `docker ${args[0]} failed`));
      } else resolve(String(stdout).trim());
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DockerDesktop implements Desktop {
  constructor(
    readonly name: string,
    private readonly base: string,
    private readonly secret: string,
    private readonly onStop: () => Promise<void>,
  ) {}

  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        headers: { "x-cu-secret": this.secret, ...(init.body ? { "content-type": "application/json" } : {}) },
        signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new DesktopError(503, "desktop_unavailable", `The desktop isn't answering (${(err as Error).message}).`);
    }
    if (!res.ok) {
      let body: { error?: string; message?: string } & Record<string, unknown> = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* not JSON */
      }
      const { error, message, ...extra } = body;
      throw new DesktopError(res.status, error ?? "desktop_error", message ?? `The desktop answered HTTP ${res.status}.`, Object.keys(extra).length ? extra : undefined);
    }
    return res;
  }

  async health(): Promise<{ ok: boolean; browser: boolean }> {
    const r = await this.call("/health", { timeoutMs: 3000 });
    return (await r.json()) as { ok: boolean; browser: boolean };
  }

  async snapshot(): Promise<TextSnapshot> {
    return (await (await this.call("/snapshot")).json()) as TextSnapshot;
  }

  async screenshot(format: "png" | "jpeg") {
    const r = await this.call(`/screenshot?format=${format}`);
    return { contentType: r.headers.get("content-type") ?? (format === "png" ? "image/png" : "image/jpeg"), data: Buffer.from(await r.arrayBuffer()) };
  }

  async act(action: ActionRequest): Promise<ActionResult> {
    const r = await this.call("/action", { method: "POST", body: JSON.stringify(action), timeoutMs: 90_000 });
    return (await r.json()) as ActionResult;
  }

  async stream(signal: AbortSignal) {
    const r = await this.call("/stream", { signal });
    if (!r.body) throw new DesktopError(502, "stream_failed", "The desktop sent no stream.");
    return { contentType: r.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=frame", body: r.body };
  }

  stop(): Promise<void> {
    return this.onStop();
  }
}

export class DockerDesktopDriver implements DesktopDriver {
  private readonly log: (msg: string) => void;
  private readonly running = new Set<string>();
  private readonly removing = new Map<string, Promise<void>>();
  private checked?: { at: number; result: { ok: true } | { ok: false; reason: string } };

  constructor(private readonly opts: DockerDriverOptions) {
    this.log = opts.log ?? ((m) => console.log(`[computer-use] ${m}`));
  }

  async check(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const status = this.opts.imageStatus?.();
    if (status === "building") return { ok: false, reason: "The computer's desktop image is still being built; try again in a minute." };
    if (this.checked && Date.now() - this.checked.at < 5000) return this.checked.result;
    let result: { ok: true } | { ok: false; reason: string };
    try {
      await docker(["image", "inspect", "--format", "{{.Id}}", this.opts.image], 10_000);
      result = { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      result = /no such image|not found/i.test(msg)
        ? { ok: false, reason: `The desktop image ${this.opts.image} isn't built.` }
        : { ok: false, reason: "Docker isn't reachable on this machine." };
    }
    this.checked = { at: Date.now(), result };
    return result;
  }

  async start(sessionId: string): Promise<Desktop> {
    if (!/^[a-z0-9_]+$/i.test(sessionId)) throw new DesktopError(400, "invalid_session", "Bad session id.");
    const name = `${CONTAINER_PREFIX}${sessionId}`;
    const secret = randomBytes(24).toString("hex");
    const o = this.opts;
    const args = [
      "run", "-d", "--init",
      "--name", name,
      "--hostname", "computer",
      "--label", `${LABEL}=1`,
      "--label", `${LABEL}.instance=${o.instance}`,
      "--label", `${LABEL}.session=${sessionId}`,
      "--memory", o.memory, "--memory-swap", o.memory,
      "--cpus", o.cpus,
      "--pids-limit", "512",
      "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=768m,mode=1777",
      "--tmpfs", "/run:rw,nosuid,nodev,size=1m",
      "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
      ...o.dns.flatMap((d) => ["--dns", d]),
      "--log-opt", "max-size=1m", "--log-opt", "max-file=1",
      "--env", `CU_SECRET=${secret}`,
      ...(o.access === "publish" ? ["-p", `127.0.0.1::${CONTROL_PORT}`] : []),
      o.image,
    ];
    this.running.add(name);
    try {
      await docker(args, 60_000);
    } catch (err) {
      this.running.delete(name);
      await docker(["rm", "-f", name], 20_000).catch(() => undefined);
      throw new DesktopError(503, "desktop_failed", `The desktop couldn't start: ${(err as Error).message}`);
    }
    const stop = () => this.remove(name);
    try {
      const base = await this.address(name);
      const desktop = new DockerDesktop(name, base, secret, stop);
      await this.waitReady(name, desktop);
      this.log(`desktop ${name} is up`);
      return desktop;
    } catch (err) {
      await stop();
      if (err instanceof DesktopError) throw err;
      throw new DesktopError(503, "desktop_failed", `The desktop couldn't start: ${(err as Error).message}`);
    }
  }

  private async address(name: string): Promise<string> {
    if (this.opts.access === "publish") {
      const out = await docker(["port", name, `${CONTROL_PORT}/tcp`], 10_000);
      const hostPort = out.split("\n")[0]?.trim();
      if (!hostPort) throw new Error("no published port");
      return `http://${hostPort}`;
    }
    const ip = await docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", name], 10_000);
    const first = ip.split(/\s+/).find(Boolean);
    if (!first) throw new Error("the container has no IP address");
    return `http://${first}:${CONTROL_PORT}`;
  }

  private async waitReady(name: string, desktop: DockerDesktop): Promise<void> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 45_000);
    while (Date.now() < deadline) {
      try {
        const h = await desktop.health();
        if (h.ok && h.browser) return;
      } catch {
        /* not up yet */
      }
      const state = await docker(["inspect", "--format", "{{.State.Status}}", name], 10_000).catch(() => "gone");
      if (state !== "running" && state !== "created") {
        const logs = await docker(["logs", "--tail", "15", name], 10_000).catch(() => "");
        throw new DesktopError(503, "desktop_failed", `The desktop stopped while starting (${state}). ${logs.split("\n").slice(-3).join(" ")}`.trim());
      }
      await sleep(300);
    }
    throw new DesktopError(503, "desktop_failed", "The desktop didn't come up in time.");
  }

  /** Remove one desktop (once, however many times it is asked). */
  private remove(name: string): Promise<void> {
    let p = this.removing.get(name);
    if (!p) {
      p = docker(["rm", "-f", name], 30_000).then(
        () => undefined,
        (e: Error) => {
          if (!/no such container|already in progress/i.test(e.message)) this.log(`removing ${name} failed: ${e.message}`);
        },
      );
      p.finally(() => {
        this.running.delete(name);
        this.removing.delete(name);
      });
      this.removing.set(name, p);
    }
    return p;
  }

  async cleanup(): Promise<void> {
    let names: string[] = [];
    try {
      const out = await docker(["ps", "-a", "--filter", `label=${LABEL}.instance=${this.opts.instance}`, "--format", "{{.Names}}"], 15_000);
      names = out.split(/\s+/).filter(Boolean);
    } catch (err) {
      this.log(`listing desktops failed: ${(err as Error).message}`);
    }
    await Promise.all([...new Set([...names, ...this.running, ...this.removing.keys()])].map((n) => this.remove(n)));
  }
}

// ---- the image -------------------------------------------------------------------------------------

/** A hash of the build context, stored as an image label, so a changed Dockerfile rebuilds the image. */
export function contextHash(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).sort()) {
    h.update(f);
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest("hex").slice(0, 16);
}

export type ImageStatus = "ready" | "building" | "missing" | "failed";

/** Build the desktop image if it is missing or out of date. Resolves to its status. */
export async function ensureImage(image: string, contextDir: string, log: (m: string) => void, onStatus: (s: ImageStatus) => void): Promise<ImageStatus> {
  const hash = contextHash(contextDir);
  let current = "";
  try {
    current = await docker(["image", "inspect", "--format", `{{index .Config.Labels "${LABEL}.hash"}}`, image], 15_000);
  } catch (err) {
    if (!/no such image|not found/i.test((err as Error).message)) {
      log(`Docker isn't reachable (${(err as Error).message}); the computer stays offline`);
      onStatus("missing");
      return "missing";
    }
  }
  if (current === hash) {
    onStatus("ready");
    return "ready";
  }
  log(current ? `desktop image ${image} is out of date; rebuilding` : `building the desktop image ${image} (first run takes a few minutes)`);
  onStatus("building");
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn("docker", ["build", "--label", `${LABEL}.hash=${hash}`, "-t", image, contextDir], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (b: Buffer) => {
      tail = (tail + b.toString()).slice(-2000);
    };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    p.on("error", () => resolve(false));
    p.on("close", (code) => {
      if (code !== 0) log(`desktop image build failed:\n${tail}`);
      resolve(code === 0);
    });
  });
  const status: ImageStatus = ok ? "ready" : "failed";
  if (ok) log(`desktop image ${image} is ready`);
  onStatus(status);
  return status;
}
