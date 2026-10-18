/**
 * Real end-to-end run against Docker (not part of `npm test`): `npm run computer-use:e2e`.
 *
 * Builds the image, starts a mock facilitator and the computer on their own ports, then pays for a
 * session, browses, clicks a link found in the text snapshot, takes a screenshot, watches the
 * stream, queues a second session, ends the first (the second starts), lets a lease lapse, checks
 * that the desktop can't reach the host, and removes every container it started.
 *
 * Env: E2E_OUT (where screenshots go, default ./.data/computer-use-e2e), E2E_PORT (computer, 4490),
 * E2E_FACILITATOR_PORT (4491), E2E_CHROME (a host Chrome/Chromium binary, to screenshot the viewer
 * page; optional), E2E_CHROME_PORT (its debugging port, 4492).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { loadConfig } from "@allowance/shared";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { createComputerUseApp } from "./app.js";
import { loadComputerUseConfig } from "./config.js";
import { docker, DockerDesktopDriver, ensureImage, LABEL } from "./docker.js";

const PORT = Number(process.env.E2E_PORT ?? 4490);
const FAC_PORT = Number(process.env.E2E_FACILITATOR_PORT ?? 4491);
const CHROME_PORT = Number(process.env.E2E_CHROME_PORT ?? 4492);
const OUT = resolve(process.env.E2E_OUT ?? ".data/computer-use-e2e");
const INSTANCE = `e2e-${PORT}`;
mkdirSync(OUT, { recursive: true });

const results: { step: string; ok: boolean; detail: string; ms: number }[] = [];
const t0 = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function step(name: string, ok: boolean, detail = "") {
  results.push({ step: name, ok, detail, ms: Date.now() - t0 });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) throw new Error(`${name}: ${detail}`);
}
const listen = (s: Server, port: number, host = "0.0.0.0") => new Promise<void>((r) => s.listen(port, host, () => r()));

const buyer = privateKeyToAccount(generatePrivateKey());
const client = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));
const payFetch = wrapFetchWithPayment(fetch, client);
const root = `http://127.0.0.1:${PORT}`;

async function json(method: string, url: string, body?: unknown, paid = false) {
  const f = paid ? payFetch : fetch;
  const r = await f(url, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const settled = r.headers.get("payment-response");
  return { status: r.status, body: (await r.json()) as Record<string, any>, settled: settled ? (decodePaymentResponseHeader(settled) as { success: boolean }) : undefined };
}
async function balance(addr: string) {
  return ((await (await fetch(`http://127.0.0.1:${FAC_PORT}/balance/${addr}`)).json()) as { balance: string }).balance;
}
async function containers(): Promise<string[]> {
  const out = await docker(["ps", "-a", "--filter", `label=${LABEL}.instance=${INSTANCE}`, "--format", "{{.Names}}"]);
  return out.split("\n").filter(Boolean);
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Screenshot a page with a host Chrome over its DevTools protocol (Node's WebSocket). */
async function chromeShot(binary: string, url: string, file: string, waitMs: number) {
  const profile = mkdtempSync(join(OUT, "chrome-"));
  const proc = spawn(binary, ["--headless=new", `--remote-debugging-port=${CHROME_PORT}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1120,860", "about:blank"], { stdio: "ignore" });
  try {
    const target = await waitFor(
      "chrome",
      async () => {
        try {
          const list = (await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
          return list.find((t) => t.type === "page");
        } catch {
          return undefined;
        }
      },
      15_000,
    );
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let id = 0;
    const waiting = new Map<number, (v: any) => void>();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && waiting.has(m.id)) waiting.get(m.id)!(m.result);
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((r) => {
        waiting.set(++id, r);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Emulation.setDeviceMetricsOverride", { width: 1120, height: 860, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await send("Page.navigate", { url });
    await sleep(waitMs);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    ws.close();
  } finally {
    proc.kill("SIGTERM");
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  // 1. The image.
  const contextDir = fileURLToPath(new URL("../docker", import.meta.url));
  const cfg = loadComputerUseConfig({ ...process.env, COMPUTER_USE_PORT: String(PORT), COMPUTER_USE_URL: root });
  const built = await ensureImage(cfg.docker.image, contextDir, (m) => console.log(`[image] ${m}`), () => {});
  step("build the image", built === "ready", cfg.docker.image);

  // 2. A mock facilitator and the computer, on their own ports.
  const dataDir = join(OUT, "data");
  mkdirSync(dataDir, { recursive: true });
  const fac = createServer(createFacilitatorApp({ ...loadConfig(), ownerApiKey: undefined, dataDir }, { quiet: true }));
  await listen(fac, FAC_PORT, "127.0.0.1");
  const driver = new DockerDesktopDriver({ ...cfg.docker, instance: INSTANCE, log: (m) => console.log(`[driver] ${m}`) });
  await driver.cleanup();
  const app = createComputerUseApp(
    { ...cfg, dataDir, chainMode: "mock", facilitatorUrl: `http://127.0.0.1:${FAC_PORT}`, x402FacilitatorUrl: `http://127.0.0.1:${FAC_PORT}`, computerUseStartGraceSeconds: 90 },
    { driver, quiet: true },
  );
  const srv = createServer(app);
  await listen(srv, PORT);
  await fetch(`http://127.0.0.1:${FAC_PORT}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: buyer.address, amount: "2.00" }) });
  step("start the facilitator and the computer", true, `computer ${root}, facilitator :${FAC_PORT}, buyer $${await balance(buyer.address)}`);

  try {
    // 3. Pay for a session.
    const created = await json("POST", `${root}/computer/sessions`, { label: "e2e" });
    step("create a session (free)", created.status === 201 && created.body.status === "active", `${created.body.id} seat ${created.body.seat}`);
    const A = { id: created.body.id as string, token: created.body.token as string, viewUrl: created.body.viewUrl as string };
    const a = (path: string, q = "") => `${root}/computer/sessions/${A.id}${path}?token=${A.token}${q}`;
    const tStart = Date.now();
    const time = await json("POST", a("/time", "&minutes=2"), undefined, true);
    step("pay for 2 minutes (desktop up)", time.status === 200 && !!time.settled?.success, `lease ${time.body.lease?.secondsLeft} s, ${Date.now() - tStart} ms incl. container start; buyer $${await balance(buyer.address)}`);
    step("one container per session", (await containers()).length === 1, (await containers()).join(", "));

    // 4. Navigate.
    const nav = await json("POST", a("/actions/navigate"), { url: "https://example.com" }, true);
    step("navigate to https://example.com ($0.005)", nav.status === 200 && /example\.com/.test(nav.body.url), `${nav.body.title}`);
    const snap1 = await json("GET", a("/snapshot"), undefined, true);
    step("text snapshot ($0.002)", snap1.status === 200 && snap1.body.text.length > 20, `${snap1.body.elements.length} elements, ${snap1.body.text.length} chars`);
    writeFileSync(join(OUT, "snapshot-example.json"), JSON.stringify(snap1.body, null, 2));

    // 5. Click a link found in the text snapshot (example.com no longer has one, so use the first website).
    let snap = snap1.body;
    if (!snap.elements.some((e: { role: string }) => e.role === "link")) {
      const nav2 = await json("POST", a("/actions/navigate"), { url: "https://info.cern.ch" }, true);
      step("navigate to a page with links", nav2.status === 200, nav2.body.url);
      snap = (await json("GET", a("/snapshot"), undefined, true)).body;
    }
    writeFileSync(join(OUT, "snapshot-before-click.json"), JSON.stringify(snap, null, 2));
    const link = snap.elements.find((e: { role: string }) => e.role === "link");
    step("find a link in the snapshot", !!link, link ? `[${link.n}] ${link.label} at ${link.x},${link.y}` : "none");
    const click = await json("POST", a("/actions/click"), { element: link.n }, true);
    step("click it by number ($0.005)", click.status === 200 && click.body.url !== snap.url, `now at ${click.body.url} (${click.body.title})`);
    const after = (await json("GET", a("/snapshot"), undefined, true)).body;
    writeFileSync(join(OUT, "snapshot-after-click.json"), JSON.stringify(after, null, 2));

    // 6. Screenshot.
    const shot = await payFetch(a("/screenshot", "&format=png"), { headers: { accept: "image/png" } });
    const png = Buffer.from(await shot.arrayBuffer());
    writeFileSync(join(OUT, "screenshot.png"), png);
    step("screenshot ($0.003)", shot.status === 200 && png.subarray(1, 4).toString() === "PNG", `${png.length} bytes → screenshot.png`);

    // Isolation: the desktop's browser can't reach this host's services.
    const hostIp = (await docker(["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"])).trim() || "172.17.0.1";
    const before = await balance(buyer.address);
    const probe = await json("POST", a("/actions/navigate"), { url: `http://${hostIp}:${PORT}/computer` }, true);
    step("the desktop can't reach the host (not charged)", probe.status === 422 && (await balance(buyer.address)) === before, `${probe.status} ${probe.body.message}`);
    await json("POST", a("/actions/back"), {}, true);

    // 7. Watch the stream.
    const viewToken = new URL(A.viewUrl).searchParams.get("token")!;
    const ac = new AbortController();
    const stream = await fetch(`${root}/computer/sessions/${A.id}/stream?token=${viewToken}`, { signal: ac.signal });
    const reader = stream.body!.getReader();
    let bytes = Buffer.alloc(0);
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes = Buffer.concat([bytes, Buffer.from(value)]);
    }
    ac.abort();
    const frames = bytes.toString("latin1").split("--frame").length - 1;
    const s0 = bytes.indexOf(Buffer.from([0xff, 0xd8]));
    const e0 = bytes.indexOf(Buffer.from([0xff, 0xd9]), s0);
    if (s0 >= 0 && e0 > s0) writeFileSync(join(OUT, "stream-frame.jpg"), bytes.subarray(s0, e0 + 2));
    step("watch the stream for 4 s (free)", stream.status === 200 && frames >= 8, `${frames} frames, ${(bytes.length / 1024).toFixed(0)} KB → stream-frame.jpg`);

    // The viewer page, as a person sees it.
    if (process.env.E2E_CHROME) {
      await chromeShot(process.env.E2E_CHROME, `${A.viewUrl.replace("localhost", "127.0.0.1")}`, join(OUT, "viewer.png"), 4000);
      step("viewer page screenshot", true, "viewer.png");
    }

    // 8. Queue a second session; end the first; the second starts.
    const second = await json("POST", `${root}/computer/sessions`, { label: "e2e-second" });
    step("a second session queues (free)", second.status === 202 && second.body.status === "queued" && second.body.position === 1, `${second.body.id} position ${second.body.position}, ~${second.body.estimatedWaitSeconds} s`);
    const B = { id: second.body.id as string, token: second.body.token as string, viewUrl: second.body.viewUrl as string };
    const b = (path: string, q = "") => `${root}/computer/sessions/${B.id}${path}?token=${B.token}${q}`;
    if (process.env.E2E_CHROME) await chromeShot(process.env.E2E_CHROME, B.viewUrl.replace("localhost", "127.0.0.1"), join(OUT, "viewer-queued.png"), 2500);
    const status1 = (await json("GET", a(""))).body;
    const ended = await json("POST", a("/end"));
    step("end the first session (free)", ended.status === 200 && ended.body.endReason === "ended", `spent $${ended.body.spent.total} (${status1.spent.minutesBought} min, ${ended.body.spent.actionCount} actions, ${ended.body.spent.readCount} reads)`);
    const bActive = await waitFor("the second session to start", async () => {
      const s = (await json("GET", b(""))).body;
      return s.status === "active" && s.desktop === "ready" ? s : undefined;
    }, 60_000);
    const names = await containers();
    step("the second starts automatically; the first container is gone", names.length === 1 && names[0] === `allowance-cu-${B.id}`, `${bActive.status} on seat ${bActive.seat}; containers: ${names.join(", ")}`);

    // 9. Let a lease lapse.
    const bt = await json("POST", b("/time", "&minutes=1"), undefined, true);
    step("buy 1 minute for the second session", bt.status === 200, `lease ${bt.body.lease.secondsLeft} s`);
    await json("POST", b("/actions/navigate"), { url: "https://example.org" }, true);
    if (process.env.E2E_CHROME) await chromeShot(process.env.E2E_CHROME, B.viewUrl.replace("localhost", "127.0.0.1"), join(OUT, "viewer-live.png"), 4000);
    console.log("      waiting about 60 s for the lease to lapse…");
    const lapsed = await waitFor("the lease to lapse", async () => {
      const s = (await json("GET", b(""))).body;
      return s.status === "ended" ? s : undefined;
    }, 80_000);
    await sleep(1500);
    step("the lease lapses; the session ends and its desktop is removed", lapsed.endReason === "lease_lapsed" && (await containers()).length === 0, `${lapsed.endReason}, spent $${lapsed.spent.total}; containers left: ${(await containers()).length}`);
    const late = await json("POST", b("/actions/click"), { element: 1 }, true);
    step("acting after the lapse is refused and free", late.status === 410, `${late.status} ${late.body.error}`);
    if (process.env.E2E_CHROME) await chromeShot(process.env.E2E_CHROME, B.viewUrl.replace("localhost", "127.0.0.1"), join(OUT, "viewer-ended.png"), 2000);
  } finally {
    await app.locals.shutdown();
    srv.close();
    fac.close();
    const left = await containers();
    step("cleanup: no allowance-cu- containers left", left.length === 0, left.join(", "));
    writeFileSync(join(OUT, "e2e-results.json"), JSON.stringify({ at: new Date().toISOString(), buyer: buyer.address, results }, null, 2));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
