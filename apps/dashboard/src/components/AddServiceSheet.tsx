/**
 * "Add service" (§18): one way to add anything. One input searches the directory or takes a link.
 * Pick a directory service, or paste a link and the wallet works out what it is (a directory
 * service, a Shopify store, or an API that charges over x402). Then the cap (stores and APIs) and
 * the agents, and Connect. Owner power, dashboard only: `GET /v1/directory/preview` and
 * `POST /v1/directory/add` via the dashboard proxy (owner key).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { isShopifyGrant, money } from "../format";
import { capMeta, capUnit } from "../lines";
import { checkApiCap, DIRECTORY_ID, looksLikeLink, matchService, serviceLinkError } from "../services";
import { shortMoney } from "../sheets";
import { addStoreBody, CAP_CHIPS, catalogLine, checkCap, DEFAULT_CAP, HOW_IT_PAYS, sampleImagesOf, serviceIdFor, storeErrorMessage, storefrontHost } from "../shopify";
import type { AgentPublic, DirectoryService, ResolvedKind, ServiceManifest, ShopifyStore } from "../types";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { CreditCard, Search } from "./Icons";
import { CUSTOM, Field, SheetShell } from "./SheetParts";
import { SampleImages, StorefrontLink } from "./ShopifyParts";

const DEBOUNCE_MS = 450;

type Svc = Pick<ServiceManifest, "id" | "name" | "provider" | "color" | "pricing" | "maxPrice" | "baseUrl"> & Partial<ServiceManifest>;

/** What the owner is about to connect. `url` is what the add call sends. */
interface Picked {
  kind: ResolvedKind;
  url: string;
  service: Svc;
  store?: ShopifyStore;
  /** Agent ids that already have it. */
  connectedAgents: string[];
  /** A store the directory already lists (§18): connecting it takes the cap. */
  listed?: boolean;
  /** x402: what the link asks for; the cap can't go below it. */
  price?: string;
  /** Picked from the list (Change clears the pick, not the search). */
  fromList?: boolean;
}

type Preview = { phase: "idle" } | { phase: "checking" } | { phase: "error"; message: string };

interface Props {
  adapter: WalletAdapter | null;
  offline?: boolean;
  /** Embedded in the chat (`?sheet=add-service&embed=1`): a flat card, and it loads its own data. */
  embed?: boolean;
  /** From `&agent=<name>`: ticked in the Connect step. */
  preselect?: string;
  /** Live data from the dashboard. Omitted (embed): loaded here. */
  agents?: AgentPublic[];
  directory?: DirectoryService[];
  onClose(): void;
  /** Done: the parent refreshes, shows the service (and lists a new store right away). */
  onDone(serviceId: string, listed?: DirectoryService, name?: string): void;
}

/** The wallet doesn't have the §18 endpoints yet. */
const predates18 = (err: unknown) => err instanceof HttpError && err.status === 404 && (!err.code || err.code === "service_not_found");

/** A store as a service, for a wallet that predates §18 (the preview came from the §15.3 endpoint). */
function storeAsService(store: ShopifyStore): Svc {
  return { id: serviceIdFor(store.handle), name: store.name, provider: storefrontHost(store), color: "#95BF47", pricing: "Store prices", maxPrice: DEFAULT_CAP, baseUrl: store.storefrontUrl ?? "", shopify: store };
}

export function AddServiceSheet({ adapter, offline = false, embed = false, preselect, agents: liveAgents, directory: liveDirectory, onClose, onDone }: Props) {
  const [own, setOwn] = useState<{ agents: AgentPublic[]; directory: DirectoryService[] } | null>(null);
  useEffect(() => {
    if (!adapter || (liveAgents && liveDirectory)) return;
    let live = true;
    Promise.all([adapter.getAgents(), adapter.getDirectory().catch(() => [] as DirectoryService[])]).then(
      ([agents, directory]) => live && setOwn({ agents, directory }),
      () => live && setOwn({ agents: [], directory: [] }),
    );
    return () => {
      live = false;
    };
  }, [adapter, liveAgents, liveDirectory]);
  const agents = liveAgents ?? own?.agents ?? [];
  const directory = liveDirectory ?? own?.directory ?? [];
  const preId = preselect ? agents.find((a) => a.name === preselect)?.id : undefined;
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [preview, setPreview] = useState<Preview>({ phase: "idle" });
  const [capChoice, setCapChoice] = useState<string>(DEFAULT_CAP);
  const [capCustom, setCapCustom] = useState("");
  const [apiCap, setApiCap] = useState("");
  const [connectTo, setConnectTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const pasted = useRef(false);

  useEffect(() => {
    if (!embed) inputRef.current?.focus();
  }, [embed]);

  const link = looksLikeLink(q);
  const listed = useMemo(() => directory.filter((s) => s.id !== DIRECTORY_ID && s.kind !== "directory"), [directory]);
  const matches = useMemo(() => (link ? [] : listed.filter((s) => matchService(s, q))), [listed, q, link]);

  const choose = (p: Picked) => {
    setPicked(p);
    setConnectTo(preId && !p.connectedAgents.includes(preId) ? [preId] : []);
    setError(undefined);
    // A listed store keeps its cap unless the owner changes it.
    const cap = p.kind === "shopify" && p.listed && p.service.maxPrice ? (Number(p.service.maxPrice) || 0).toFixed(2) : DEFAULT_CAP;
    const chip = (CAP_CHIPS as readonly string[]).includes(cap);
    setCapChoice(chip ? cap : CUSTOM);
    setCapCustom(chip ? "" : cap);
    setApiCap(p.kind === "x402" ? (Number(p.service.maxPrice) || 0).toFixed(2) : "");
  };

  // A link: ask the wallet what it is (debounced, immediate on paste, stale answers ignored).
  useEffect(() => {
    const mine = ++seq.current;
    const fast = pasted.current;
    pasted.current = false;
    if (!link) {
      setPreview({ phase: "idle" });
      setPicked((p) => (p && !p.fromList ? null : p));
      return;
    }
    setPicked((p) => (p && p.url === q.trim() ? p : null));
    const t = setTimeout(async () => {
      if (mine !== seq.current || !adapter) return;
      setPreview({ phase: "checking" });
      const url = q.trim();
      try {
        let found: Picked;
        try {
          const r = await adapter.previewService(url);
          found = {
            kind: r.kind,
            url,
            service: r.service,
            store: r.store,
            listed: r.listed,
            price: r.price ?? r.service.maxPrice,
            connectedAgents: r.connectedAgents ?? agents.filter((a) => a.services?.some((s) => s.id === r.service.id)).map((a) => a.id),
          };
        } catch (err) {
          // A wallet without §18 reads "preview" as a service id (404 service_not_found), or has no
          // such route (404, no code): fall back to the store preview (§15.3).
          if (!predates18(err)) throw err;
          const store = await adapter.previewShopifyStore(url);
          found = { kind: "shopify", url, service: storeAsService(store), store, connectedAgents: [] };
        }
        if (mine !== seq.current) return;
        setPreview({ phase: "idle" });
        choose(found);
      } catch (err) {
        if (mine !== seq.current) return;
        const e = err as Error;
        const info = e instanceof HttpError ? { status: e.status, code: e.code, message: e.message } : { message: e.message };
        setPreview({ phase: "error", message: info.code === "store_not_found" ? storeErrorMessage(info) : serviceLinkError(info) });
      }
    }, fast ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, link, adapter]);

  const kind = picked?.kind;
  const storeCap = capChoice === CUSTOM ? checkCap(capCustom) : checkCap(capChoice);
  const x402Cap = kind === "x402" ? checkApiCap(apiCap, picked?.price ?? picked?.service.maxPrice) : null;
  const already = new Set(picked?.connectedAgents ?? []);
  const newAgents = connectTo.filter((id) => !already.has(id));
  const capOk = kind === "shopify" ? storeCap.ok : kind === "x402" ? !!x402Cap?.ok : true;
  // Re-adding an API its agents already have only raises its cap (§18).
  const capRaise = kind === "x402" && already.size > 0 && !!x402Cap?.ok && x402Cap.amount !== (Number(picked?.service.maxPrice) || 0).toFixed(2);
  // A new store can be listed with no agent yet; anything else needs an agent (or, for an API, a new cap).
  const canSubmit = !!adapter && !!picked && !busy && capOk && ((kind === "shopify" && !picked.listed) || newAgents.length > 0 || capRaise);

  const toggleAgent = (id: string) => setConnectTo((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const submit = async () => {
    if (!adapter || !picked || !canSubmit) return;
    setBusy(true);
    setError(undefined);
    try {
      if (picked.kind === "directory") {
        for (const id of newAgents) await adapter.connectService(id, picked.service.id);
        onDone(picked.service.id, undefined, picked.service.name);
        return;
      }
      const maxPrice = picked.kind === "shopify" ? (storeCap.ok ? storeCap.amount : undefined) : x402Cap?.ok ? x402Cap.amount : undefined;
      try {
        const res = await adapter.addService({ url: picked.url, ...(maxPrice ? { maxPrice } : {}), ...(newAgents.length ? { connectTo: newAgents } : {}) });
        onDone(res.service.id, res.kind === "shopify" ? (res.service as DirectoryService) : undefined, res.service.name);
      } catch (err) {
        if (!(picked.kind === "shopify" && predates18(err))) throw err;
        const res = await adapter.addShopifyStore(addStoreBody({ url: picked.url, cap: maxPrice, connectTo: newAgents }));
        onDone(res.service.id, res.service, res.service.name);
      }
    } catch (err) {
      const e = err as Error;
      setError(serviceLinkError(e instanceof HttpError ? { status: e.status, code: e.code, message: e.message } : { message: e.message }));
      setBusy(false);
    }
  };

  const n = newAgents.length;
  const agentsWord = `${n} agent${n === 1 ? "" : "s"}`;
  const label = busy
    ? "Connecting…"
    : !picked
      ? "Connect"
      : kind === "shopify" && !picked.listed
        ? n
          ? `Add and connect to ${agentsWord}`
          : `Add ${picked.service.name}`
        : n
          ? `Connect to ${agentsWord}`
          : capRaise
            ? "Update the cap"
            : "Pick an agent";

  const head = (
    <div className="osheet-title">
      <div className="osheet-titles">
        <h2 className="osheet-name">Add service</h2>
        <p className="osheet-sub">{preselect ? `For ${preselect}. ` : ""}Pick one from the directory, or paste a link.</p>
      </div>
    </div>
  );

  const footer = (
    <>
      {error && (
        <p className="field-error osheet-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
        {label}
      </button>
    </>
  );

  return (
    <SheetShell embed={embed} label="Add service" head={head} footer={footer} locked={busy} onClose={onClose}>
      {offline && !adapter && <div className="osheet-banner banner-offline">Can't reach the wallet. Start it with npm run dev. Retrying…</div>}

      <Field label="Service" htmlFor="add-q" hint={q ? undefined : "A Shopify store, any API that charges over x402, or anything in the directory."}>
        <label className="search search-wide">
          <Search width={15} height={15} />
          <input
            ref={inputRef}
            id="add-q"
            value={q}
            placeholder="Search the directory or paste a link"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="add-preview"
            onPaste={() => (pasted.current = true)}
            onChange={(e) => {
              setQ(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => e.key === "Enter" && canSubmit && void submit()}
          />
        </label>
        <div id="add-preview" aria-live="polite">
          {link && preview.phase === "checking" && (
            <p className="shop-checking">
              <span className="spinner" aria-hidden /> Looking at the link…
            </p>
          )}
          {link && preview.phase === "error" && (
            <p className="field-error" role="alert">
              {preview.message}
            </p>
          )}
        </div>
      </Field>

      {!picked && !link && (
        <ul className="ln-group" aria-label="Directory">
          {matches.map((s) => {
            const has = agents.filter((a) => a.services?.some((x) => x.id === s.id)).map((a) => a.id);
            return (
              <li key={s.id}>
                <button type="button" className="grow grow-btn" onClick={() => choose({ kind: "directory", url: s.baseUrl, service: s, connectedAgents: has, fromList: true })}>
                  <ServiceTile name={s.name} color={s.color} size="xs" shopify={isShopifyGrant(s)} />
                  <span className="grow-main">
                    <span className="grow-title">{s.name}</span>
                  </span>
                  <span className="grow-meta">
                    {isShopifyGrant(s) ? storefrontHost(s.shopify ?? undefined) : s.provider}
                    {has.length > 0 && ` · ${has.length} connected`}
                  </span>
                </button>
              </li>
            );
          })}
          {matches.length === 0 && <li className="grow muted">Nothing in the directory matches. Paste its link instead.</li>}
        </ul>
      )}

      {picked && (
        <>
          <div className="pick-card">
            <div className="grow pick-head">
              <ServiceTile name={picked.service.name} color={picked.service.color} size="sm" shopify={picked.kind === "shopify" || isShopifyGrant(picked.service)} />
              <span className="grow-main">
                <span className="grow-title">{picked.service.name}</span>
                <span className="grow-meta">
                  {picked.kind === "shopify" && picked.store ? (
                    <>
                      <StorefrontLink shop={picked.store} className="shop-link shop-link-quiet" />
                      {catalogLine(picked.store) && ` · ${catalogLine(picked.store)}`}
                      {picked.store.cardCheckout && (
                        <span title="Accepts card checkout for agents">
                          {" · "}
                          <CreditCard width={12} height={12} className="inline-ic" /> card checkout
                        </span>
                      )}
                      {picked.listed && " · in your services"}
                    </>
                  ) : picked.kind === "x402" ? (
                    ["x402 API", picked.service.provider !== picked.service.name ? picked.service.provider : "", picked.service.pricing].filter(Boolean).join(" · ")
                  ) : (
                    `${isShopifyGrant(picked.service) ? storefrontHost(picked.service.shopify ?? undefined) : picked.service.provider} · ${capMeta(picked.service.maxPrice, capUnit(picked.service.pricing, isShopifyGrant(picked.service)))}`
                  )}
                </span>
              </span>
              {picked.fromList && (
                <button type="button" className="ap-more" onClick={() => setPicked(null)}>
                  Change
                </button>
              )}
            </div>
            {picked.kind === "shopify" && picked.store && <SampleImages images={sampleImagesOf(picked.store)} label={picked.service.name} />}
            {picked.kind !== "shopify" && picked.service.summary && picked.service.summary !== picked.service.name && <p className="osheet-sub pick-sum">{picked.service.summary}</p>}
          </div>

          {kind === "shopify" && (
            <Field label="Per-order cap" hint="Orders above it are blocked. Each agent's own limits still apply.">
              <div className="amount-picker">
                <div className="chips amount-chips" role="radiogroup" aria-label="Per-order cap">
                  {CAP_CHIPS.map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={capChoice === c} className={`chip amount-chip${capChoice === c ? " chip-on" : ""}`} onClick={() => setCapChoice(c)}>
                      {shortMoney(c)}
                    </button>
                  ))}
                  <button type="button" role="radio" aria-checked={capChoice === CUSTOM} className={`chip amount-chip${capChoice === CUSTOM ? " chip-on" : ""}`} onClick={() => setCapChoice(CUSTOM)}>
                    Custom
                  </button>
                </div>
                {capChoice === CUSTOM && (
                  <div className={`money-input${capCustom && !storeCap.ok ? " input-bad" : ""}`}>
                    <span aria-hidden>$</span>
                    <input inputMode="decimal" autoComplete="off" placeholder="100" value={capCustom} aria-label="Per-order cap in dollars" onChange={(e) => setCapCustom(e.target.value)} />
                  </div>
                )}
                {capChoice === CUSTOM && capCustom && !storeCap.ok && <p className="field-error">{storeCap.message}</p>}
              </div>
            </Field>
          )}

          {kind === "x402" && (
            <Field label="Cap per request" hint={`It asks for ${money(picked.price ?? picked.service.maxPrice)}. Raise the cap if its price may go up.`}>
              <div className={`money-input money-input-sm${x402Cap && !x402Cap.ok ? " input-bad" : ""}`}>
                <span aria-hidden>$</span>
                <input inputMode="decimal" autoComplete="off" value={apiCap} aria-label="Cap per request in dollars" onChange={(e) => setApiCap(e.target.value)} />
              </div>
              {x402Cap && !x402Cap.ok && <p className="field-error">{x402Cap.message}</p>}
            </Field>
          )}

          <Field label="Connect to" aside={kind === "shopify" && !picked.listed ? "Optional" : undefined}>
            <ul className="ln-group">
              {agents.map((a) => {
                const has = already.has(a.id);
                const on = has || connectTo.includes(a.id);
                return (
                  <li key={a.id}>
                    <label className={`grow pick${on ? " pick-on" : ""}${has ? " pick-locked" : ""}`}>
                      <AgentAvatar name={a.name} size="xs" />
                      <span className="grow-main">
                        <span className="grow-title">{a.name}</span>
                      </span>
                      <span className="grow-meta">{has ? "connected" : a.frozen ? "frozen" : `up to ${shortMoney(a.policy.maxPerTx)} per payment`}</span>
                      <input type="checkbox" checked={on} disabled={has} onChange={() => toggleAgent(a.id)} />
                    </label>
                  </li>
                );
              })}
              {agents.length === 0 && <li className="grow muted">No agents yet.</li>}
            </ul>
          </Field>

          {kind === "shopify" && <p className="osheet-note">{HOW_IT_PAYS}</p>}
        </>
      )}
    </SheetShell>
  );
}
