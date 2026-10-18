/**
 * "Add a Shopify store" (§15.5): paste any store or product link, see what the bridge finds (live,
 * debounced: name, storefront, product pictures, catalog size, card checkout), set a per-order cap,
 * optionally connect agents, add. Owner power: `POST /v1/directory/shopify` via the dashboard proxy
 * (owner key). Dashboard-only (not embedded in the chat). Shopper side only: no store admin.
 */
import { useEffect, useRef, useState } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { shortMoney } from "../sheets";
import {
  addStoreBody,
  CAP_CHIPS,
  catalogLine,
  checkCap,
  checkStoreLink,
  DEFAULT_CAP,
  existingStore,
  HOW_IT_PAYS,
  sampleImagesOf,
  storeErrorMessage,
} from "../shopify";
import type { AgentPublic, DirectoryService, ShopifyStore } from "../types";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { Check, CreditCard, Info } from "./Icons";
import { CUSTOM, Field, SheetShell } from "./SheetParts";
import { SampleImages, StorefrontLink } from "./ShopifyParts";

const DEBOUNCE_MS = 450;

interface Props {
  adapter: WalletAdapter | null;
  offline?: boolean;
  agents: AgentPublic[];
  /** What the dashboard already lists, to say "already in your services". */
  directory: DirectoryService[];
  onClose(): void;
  /** Added: the parent shows it (and closes this sheet). */
  onAdded(service: DirectoryService): void;
  /** "Open it" on a store that is already there. */
  onOpen(serviceId: string): void;
}

type Preview =
  | { phase: "idle" }
  | { phase: "typing"; key: string }
  | { phase: "bad"; message: string }
  | { phase: "checking"; key: string }
  | { phase: "ok"; key: string; url: string; store: ShopifyStore }
  | { phase: "error"; key: string; message: string };

export function AddShopifySheet({ adapter, offline = false, agents, directory, onClose, onAdded, onOpen }: Props) {
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<Preview>({ phase: "idle" });
  const [capChoice, setCapChoice] = useState<string>(DEFAULT_CAP);
  const [capCustom, setCapCustom] = useState("");
  const [connectTo, setConnectTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const capRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const pasted = useRef(false);
  const cache = useRef(new Map<string, { store: ShopifyStore } | { message: string }>());

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Live preview: debounced (immediate on paste), stale answers ignored, answers cached per host.
  useEffect(() => {
    const check = checkStoreLink(link);
    const mine = ++seq.current;
    const fast = pasted.current;
    pasted.current = false;
    if (check.state === "idle") {
      setPreview({ phase: "idle" });
      return;
    }
    if (check.state === "bad") {
      // Don't flash an error at every keystroke: say it once the owner pauses.
      setPreview({ phase: "typing", key: "" });
      const t = setTimeout(() => mine === seq.current && setPreview({ phase: "bad", message: check.message }), fast ? 0 : DEBOUNCE_MS + 250);
      return () => clearTimeout(t);
    }
    const { key, url } = check;
    const known = cache.current.get(key);
    if (known) {
      setPreview("store" in known ? { phase: "ok", key, url, store: known.store } : { phase: "error", key, message: known.message });
      return;
    }
    setPreview((p) => (p.phase === "ok" && p.key === key ? p : { phase: "typing", key }));
    const t = setTimeout(async () => {
      if (mine !== seq.current || !adapter) return;
      setPreview({ phase: "checking", key });
      try {
        const store = await adapter.previewShopifyStore(url);
        cache.current.set(key, { store });
        if (mine === seq.current) setPreview({ phase: "ok", key, url, store });
      } catch (err) {
        const e = err as Error;
        const message = storeErrorMessage(e instanceof HttpError ? { status: e.status, code: e.code, message: e.message } : { message: e.message });
        // Only remember answers about the store itself, not a bridge that was briefly down.
        if (e instanceof HttpError && [400, 404, 422].includes(e.status)) cache.current.set(key, { message });
        if (mine === seq.current) setPreview({ phase: "error", key, message });
      }
    }, fast ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [link, adapter]);

  const store = preview.phase === "ok" ? preview.store : undefined;
  const already = store ? existingStore(directory, store) : undefined;
  const cap = capChoice === CUSTOM ? checkCap(capCustom) : checkCap(capChoice);
  const capValue = cap.ok ? cap.amount : undefined;
  const canAdd = !!adapter && !!store && !already && !busy && cap.ok;
  const pickable = agents;

  const toggleAgent = (id: string) => setConnectTo((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const add = async () => {
    if (!adapter || !store || preview.phase !== "ok") return;
    if (!cap.ok) {
      capRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const ids = connectTo.filter((id) => agents.some((a) => a.id === id));
      const res = await adapter.addShopifyStore(addStoreBody({ url: preview.url, cap: capValue, connectTo: ids }));
      onAdded(res.service);
    } catch (err) {
      const e = err as Error;
      setError(storeErrorMessage(e instanceof HttpError ? { status: e.status, code: e.code, message: e.message } : { message: e.message }));
      setBusy(false);
    }
  };

  const head = (
    <div className="osheet-title">
      <ServiceTile name="Shopify" shopify size="xl" />
      <div className="osheet-titles">
        <h2 className="osheet-name">Add a Shopify store</h2>
        <p className="muted">Any public store. Your agents shop there for you.</p>
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
      <button type="button" className="btn btn-big" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="button" className="btn btn-primary btn-big" onClick={() => void add()} disabled={!canAdd}>
        {busy ? "Adding…" : store && !already ? `Add ${store.name}` : "Add store"}
      </button>
    </>
  );

  return (
    <SheetShell embed={false} label="Add a Shopify store" head={head} footer={footer} locked={busy} onClose={onClose}>
      {offline && !adapter && <div className="osheet-banner banner-offline">Can't reach the wallet. Start it with npm run dev. Retrying…</div>}

      <Field label="Store link" htmlFor="shop-link" hint="Paste the shop's address, or a link to any of its products.">
        <input
          ref={inputRef}
          id="shop-link"
          className={`text-input shop-link-input${preview.phase === "bad" || preview.phase === "error" ? " input-bad" : preview.phase === "ok" ? " input-ok" : ""}`}
          value={link}
          placeholder="allbirds.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          aria-invalid={preview.phase === "bad" || preview.phase === "error"}
          aria-describedby="shop-preview"
          onPaste={() => (pasted.current = true)}
          onChange={(e) => {
            setLink(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
        />
        <div id="shop-preview" className="shop-preview-slot" aria-live="polite">
          {preview.phase === "checking" && (
            <p className="shop-checking">
              <span className="spinner" aria-hidden /> Looking up the store…
            </p>
          )}
          {(preview.phase === "bad" || preview.phase === "error") && (
            <p className="field-error shop-error" role="alert">
              {preview.message}
            </p>
          )}
          {store && (
            <div className={`shop-preview${already ? " shop-preview-exists" : ""}`}>
              <div className="shop-preview-row">
                <ServiceTile name={store.name} shopify size="lg" />
                <div className="shop-preview-text">
                  <strong className="shop-preview-name">{store.name}</strong>
                  <span className="muted shop-preview-site">
                    <StorefrontLink shop={store} />
                  </span>
                  {catalogLine(store) && <span className="muted">{catalogLine(store)}</span>}
                </div>
              </div>
              <SampleImages images={sampleImagesOf(store)} label={store.name} />
              {store.cardCheckout && (
                <p className="shop-card-ok">
                  <CreditCard width={16} height={16} /> Accepts card checkout for agents
                </p>
              )}
              {already && (
                <div className="shop-exists">
                  <span>
                    <Check width={16} height={16} /> Already in your services
                  </span>
                  <button type="button" className="btn" onClick={() => onOpen(already.id)}>
                    Open it
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </Field>

      {!already && (
          <Field label="Per-order cap" hint="Orders above this are blocked. Each agent's own limits still apply: bigger orders wait for your approval.">
            <div className="amount-picker">
              <div className="chips amount-chips" role="radiogroup" aria-label="Per-order cap">
                {CAP_CHIPS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={capChoice === c} className={`chip amount-chip${capChoice === c ? " chip-on" : ""}`} onClick={() => setCapChoice(c)}>
                    {shortMoney(c)}
                  </button>
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={capChoice === CUSTOM}
                  className={`chip amount-chip${capChoice === CUSTOM ? " chip-on" : ""}`}
                  onClick={() => {
                    setCapChoice(CUSTOM);
                    requestAnimationFrame(() => capRef.current?.focus());
                  }}
                >
                  Custom
                </button>
              </div>
              {capChoice === CUSTOM && (
                <div className={`money-input${capCustom && !cap.ok ? " input-bad" : ""}`}>
                  <span aria-hidden>$</span>
                  <input
                    ref={capRef}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="100"
                    value={capCustom}
                    aria-label="Per-order cap in dollars"
                    aria-invalid={!!capCustom && !cap.ok}
                    onChange={(e) => setCapCustom(e.target.value)}
                  />
                </div>
              )}
              {capChoice === CUSTOM && capCustom && !cap.ok && (
                <p className="field-error" role="alert">
                  {cap.message}
                </p>
              )}
            </div>
          </Field>
      )}

      {!already && (
        <Field label="Connect to (optional)" hint="You can connect it later from the store's page, and agents can ask you for it.">
          <ul className="svc-picks agent-connect-picks">
            {pickable.map((a) => {
              const on = connectTo.includes(a.id);
              return (
                <li key={a.id}>
                  <label className={`svc-pick${on ? " svc-pick-on" : ""}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleAgent(a.id)} />
                    <AgentAvatar name={a.name} size="sm" />
                    <span className="svc-pick-text">
                      <strong>{a.name}</strong>
                      <small>{a.frozen ? "frozen" : `up to ${shortMoney(a.policy.maxPerTx)} per payment`}</small>
                    </span>
                    <span className="svc-pick-tick" aria-hidden>
                      <Check width={16} height={16} />
                    </span>
                  </label>
                </li>
              );
            })}
            {pickable.length === 0 && <li className="muted">No agents yet.</li>}
          </ul>
        </Field>
      )}

      {(!store || !already) && (
        <p className="osheet-info shop-how">
          <Info width={20} height={20} />
          <span>{HOW_IT_PAYS}</span>
        </p>
      )}
    </SheetShell>
  );
}
