/**
 * "New agent" (§14.3): name, purpose, starting money, limits, services. Creates the agent in the
 * wallet (owner key via the dashboard proxy), then hands its token to the chat server. The token
 * lives only in this component's state, and only when the chat could not take it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HttpError, type WalletAdapter } from "../api/adapter";
import { isShopifyGrant, money, toCents } from "../format";
import { DIRECTORY_ID } from "../services";
import { capLabel } from "../shopify";
import {
  amountInput,
  chatLinkFor,
  checkLimits,
  checkName,
  createAgentBody,
  DEFAULT_PRESET,
  LIMIT_PRESETS,
  limitsLine,
  limitsMeaning,
  MAX_PURPOSE,
  NAME_RULE,
  normalizeNameInput,
  parseAmount,
  presetLimits,
  presetOf,
  registerWithChat,
  type AmountCheck,
  type ChatRegistration,
  type Limits,
  type PresetId,
} from "../sheets";
import type { AgentPublic, DirectoryService, SummaryResponse } from "../types";
import { AgentAvatar, ServiceTile } from "./Avatar";
import { ArrowOut, Check, Cross, Warn } from "./Icons";
import { AmountPicker, CopyField, CUSTOM, Facts, Field, SheetShell } from "./SheetParts";

type Phase = "form" | "creating" | "registering" | "done";

interface Result {
  agent: AgentPublic;
  limits: Limits;
  chat: ChatRegistration;
  /** Only when the chat server did not take it: shown once, never stored or logged. */
  token?: string;
}

interface Props {
  adapter: WalletAdapter | null;
  offline?: boolean;
  embed: boolean;
  chatUrl: string;
  /** Agent names the dashboard already knows (live), on top of the ones loaded here. */
  knownNames?: string[];
  onClose(): void;
  /** The wallet created it. */
  onCreated?(agent: AgentPublic): void;
  /**
   * The owner is past the point of no return: the chat server hosts it, or the owner pressed
   * "Done" on the one-time token screen. Never while the token is still on screen (embedded, the
   * chat closes the sheet on the message this triggers).
   */
  onReady?(name: string): void;
}

const inputsFor = (l: Limits): Limits => ({ maxPerTx: amountInput(l.maxPerTx), dailyCap: amountInput(l.dailyCap), approvalThreshold: amountInput(l.approvalThreshold) });
const LIMIT_FIELDS: { key: keyof Limits; label: string }[] = [
  { key: "maxPerTx", label: "Per payment" },
  { key: "dailyCap", label: "Per day" },
  { key: "approvalThreshold", label: "Ask me above" },
];

/** `No service "acme-x" in the directory…` → a sentence for the owner. */
function serviceProblem(message: string): string {
  const id = message.match(/"([^"]+)"/)?.[1];
  return `${id ? `${id} is` : "A service you picked is"} not in the directory any more. Untick it and try again.`;
}

export function NewAgentSheet({ adapter, offline = false, embed, chatUrl, knownNames, onClose, onCreated, onReady }: Props) {
  const [names, setNames] = useState<string[]>([]);
  const [chainMode, setChainMode] = useState<SummaryResponse["chainMode"] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [directory, setDirectory] = useState<DirectoryService[] | null>(null);
  const [dirError, setDirError] = useState<string>();

  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [startChoice, setStartChoice] = useState("20.00");
  const [startCustom, setStartCustom] = useState("");
  const [limitsRaw, setLimitsRaw] = useState<Limits>(() => inputsFor(presetLimits(DEFAULT_PRESET)));
  const [preset, setPreset] = useState<PresetId>(DEFAULT_PRESET);
  const [selected, setSelected] = useState<string[]>([]);

  const [submitted, setSubmitted] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [formError, setFormError] = useState<string>();
  const [serviceError, setServiceError] = useState<string>();
  const [result, setResult] = useState<Result | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const limitsRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);

  const loadDirectory = useCallback(async (a: WalletAdapter) => {
    setDirError(undefined);
    try {
      setDirectory(await a.getDirectory());
    } catch (err) {
      setDirError(`Could not load the service directory (${(err as Error).message}). You can connect services later from Services.`);
    }
  }, []);

  useEffect(() => {
    if (!adapter) return;
    let live = true;
    adapter.getSummary().then(
      (s) => {
        if (!live) return;
        setNames(s.agents.map((a) => a.name));
        setChainMode(s.chainMode);
        setLoadError(undefined);
      },
      (err: Error) => live && setLoadError(`Could not load your agents: ${err.message}`),
    );
    void loadDirectory(adapter);
    return () => {
      live = false;
    };
  }, [adapter, loadDirectory]);

  useEffect(() => {
    if (!embed) nameRef.current?.focus();
  }, [embed]);

  const taken = useMemo(() => [...new Set([...names, ...(knownNames ?? [])])], [names, knownNames]);
  const nameCheck = checkName(name, taken);
  const chain = chainMode === "base-sepolia";
  const start: AmountCheck = chain
    ? { ok: true, amount: "0.00", cents: 0 }
    : startChoice === CUSTOM
      ? parseAmount(startCustom, { min: "0" })
      : { ok: true, amount: startChoice, cents: toCents(startChoice) };
  const limitsCheck = checkLimits(limitsRaw);
  const pickable = (directory ?? []).filter((s) => s.id !== DIRECTORY_ID);
  const dirEntry = directory?.find((s) => s.id === DIRECTORY_ID);
  const busy = phase === "creating" || phase === "registering";

  const pickPreset = (id: PresetId) => {
    setPreset(id);
    if (id !== "custom") setLimitsRaw(inputsFor(presetLimits(id)));
    else requestAnimationFrame(() => limitsRef.current?.querySelector("input")?.focus());
  };
  const editLimit = (key: keyof Limits, raw: string) => {
    const next = { ...limitsRaw, [key]: raw };
    setLimitsRaw(next);
    const c = checkLimits(next);
    setPreset(c.ok ? presetOf(c.limits) : "custom");
  };
  const toggleService = (id: string) => {
    setServiceError(undefined);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const submit = async () => {
    setSubmitted(true);
    setFormError(undefined);
    if (!adapter) return;
    if (!nameCheck.ok) return nameRef.current?.focus();
    if (!start.ok) return startRef.current?.querySelector("input")?.focus();
    if (!limitsCheck.ok) return limitsRef.current?.querySelector<HTMLInputElement>("[aria-invalid='true']")?.focus();

    const services = selected.filter((id) => pickable.some((s) => s.id === id));
    setPhase("creating");
    setServiceError(undefined);
    let created;
    try {
      created = await adapter.createAgent(createAgentBody({ name, limits: limitsCheck.limits, initialBalance: chain ? undefined : start.amount, services }));
    } catch (err) {
      setPhase("form");
      const e = err as Error;
      if (e instanceof HttpError && (e.code === "agent_exists" || e.status === 409)) {
        setNames((n) => [...n, name]);
        nameRef.current?.focus();
      } else if (e instanceof HttpError && (e.code === "service_not_found" || e.status === 404)) {
        setServiceError(serviceProblem(e.message));
        void loadDirectory(adapter);
      } else if (e instanceof HttpError && e.status === 400) {
        setFormError(e.message);
      } else {
        setFormError(`Could not create the agent: ${e.message}`);
      }
      return;
    }
    onCreated?.(created.agent);
    setPhase("registering");
    const role = purpose.trim();
    const chat = await registerWithChat(chatUrl, { name, token: created.token, ...(role ? { role } : {}) });
    setResult({ agent: created.agent, limits: limitsCheck.limits, chat, ...(chat.ok ? {} : { token: created.token }) });
    setPhase("done");
    if (chat.ok) onReady?.(name);
  };

  const head = (
    <div className="osheet-title">
      {(result || name) && <AgentAvatar name={result?.agent.name ?? name} size="sm" />}
      <div className="osheet-titles">
        <h2 className="osheet-name">{result ? result.agent.name : name || "New agent"}</h2>
        <p className="osheet-sub">{result ? "New agent" : "Its own wallet, limits and services"}</p>
      </div>
    </div>
  );

  // ---- done ----------------------------------------------------------------------------------
  if (result) {
    const { agent, chat, token, limits } = result;
    const ready = chat.ok;
    const footer = ready ? (
      embed ? (
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Start chatting with {agent.name}
        </button>
      ) : (
        <>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
          <a className="btn btn-primary" href={chatLinkFor(chatUrl, agent.name)} target="_blank" rel="noopener noreferrer">
            Open chat <ArrowOut width={18} height={18} />
          </a>
        </>
      )
    ) : (
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          onReady?.(agent.name);
          onClose();
        }}
      >
        {token ? "Done, I saved the token" : "Done"}
      </button>
    );
    return (
      <SheetShell embed={embed} label={`${agent.name} created`} head={head} footer={footer} locked={!!token} onClose={onClose}>
        <div className="done-line" role="status">
          <span className="done-check" aria-hidden>
            <Check width={14} height={14} />
          </span>
          <div>
            <h3 className="done-title">{ready ? `${agent.name} is ready` : `${agent.name} is created`}</h3>
            {ready && <p className="osheet-sub">{embed ? "It's in your chat list now." : "The chat server is hosting it. Say hello."}</p>}
          </div>
        </div>
        <Facts
          rows={[
            ["Balance", <span className="facts-num">{money(agent.balance)} <span className="muted">{chain ? "on Base Sepolia" : "test money"}</span></span>],
            ["Limits", limitsLine(limits)],
            ...(agent.services.length > 0
              ? ([
                  [
                    "Services",
                    <span className="facts-tiles">
                      {agent.services.map((s) => (
                        <span key={s.id} className="facts-tile">
                          <ServiceTile name={s.name} color={s.color} size="xs" shopify={isShopifyGrant(s)} /> {s.name}
                        </span>
                      ))}
                    </span>,
                  ],
                ] as [string, ReactNode][])
              : []),
          ]}
        />
        {chain && (
          <details className="osheet-details">
            <summary>Fund it with test USDC</summary>
            <p className="muted">Starting money isn't minted on Base Sepolia. Send test USDC to this address:</p>
            <CopyField value={agent.address} label="Agent address" />
          </details>
        )}
        {!ready && (
          <div className="token-box" role="alert">
            <p className="token-why">
              <Warn width={20} height={20} /> <span>Not added to the chat. {!chat.ok && chat.reason}</span>
            </p>
            <p className="token-label">Agent token</p>
            {token && <CopyField value={token} label="Agent token" secret />}
            <p className="token-note">Give this to Claude Desktop or the chat server; it won't be shown again.</p>
          </div>
        )}
      </SheetShell>
    );
  }

  // ---- form ----------------------------------------------------------------------------------
  const showName = name.length > 0 || submitted;
  const nameState = !showName ? "idle" : nameCheck.ok ? "ok" : "bad";
  const createLabel = phase === "creating" ? "Creating…" : phase === "registering" ? "Adding to chat…" : `Create ${nameCheck.ok ? name : "agent"}`;

  const footer = (
    <>
      {formError && (
        <p className="field-error osheet-error" role="alert">
          {formError}
        </p>
      )}
      <button type="button" className="btn" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || !adapter}>
        {createLabel}
      </button>
    </>
  );

  return (
    <SheetShell embed={embed} label="New agent" head={head} footer={footer} locked={busy} onClose={onClose}>
      {offline && !adapter && <div className="osheet-banner banner-offline">Can't reach the wallet. Start it with npm run dev. Retrying…</div>}
      {loadError && <div className="osheet-banner banner-offline">{loadError}</div>}

      <Field label="Name" htmlFor="na-name">
        <input
          ref={nameRef}
          id="na-name"
          className={`text-input name-input${nameState === "bad" ? " input-bad" : nameState === "ok" ? " input-ok" : ""}`}
          value={name}
          placeholder="travel-planner"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          aria-invalid={nameState === "bad"}
          aria-describedby="na-name-status"
          onChange={(e) => setName(normalizeNameInput(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
        <p id="na-name-status" className={`name-status name-${nameState}`} aria-live="polite">
          {nameState === "ok" && <Check width={14} height={14} />}
          {nameState === "bad" && <Cross width={14} height={14} />}
          {nameState === "idle" ? NAME_RULE : nameCheck.message}
        </p>
      </Field>

      <Field label="What it's for" htmlFor="na-purpose" aside={<span className={purpose.length > MAX_PURPOSE - 60 ? "count-near" : ""}>{purpose.length}/{MAX_PURPOSE}</span>} hint="It becomes the agent's role in its instructions.">
        <textarea
          id="na-purpose"
          className="text-input purpose-input"
          rows={3}
          maxLength={MAX_PURPOSE}
          value={purpose}
          placeholder="Plans trips: compares flights and hotels, checks the weather, and books within its limits."
          onChange={(e) => setPurpose(e.target.value.slice(0, MAX_PURPOSE))}
        />
      </Field>

      <Field label="Starting money" aside={!chain && "Up to $1,000"}>
        {chain ? (
          <p className="muted">On Base Sepolia nothing is minted. Fund its address with test USDC after you create it.</p>
        ) : (
          <div ref={startRef}>
            <AmountPicker
              id="na-start"
              label="Starting money"
              choice={startChoice}
              custom={startCustom}
              error={startChoice === CUSTOM && (submitted || startCustom) && !start.ok ? start.message : undefined}
              onChoice={setStartChoice}
              onCustom={setStartCustom}
            />
            <p className="ofield-hint">Test USDC on the mock ledger. Nothing real is charged.</p>
          </div>
        )}
      </Field>

      <Field label="Limits">
        <div className="seg preset-seg" role="radiogroup" aria-label="Limits preset">
          {LIMIT_PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={preset === p.id ? "seg-on" : ""} title={`${p.blurb}: ${limitsLine(p.limits)}`} onClick={() => pickPreset(p.id)}>
              {p.label}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={preset === "custom"} className={preset === "custom" ? "seg-on" : ""} onClick={() => pickPreset("custom")}>
            Custom
          </button>
        </div>
        <div className="limit-inputs" ref={limitsRef}>
          {LIMIT_FIELDS.map(({ key, label }) => {
            const err = limitsCheck.ok ? undefined : limitsCheck.errors[key];
            return (
              <label key={key} className="limit-field">
                <span className="limit-label">{label}</span>
                <span className={`money-input${err ? " input-bad" : ""}`}>
                  <span aria-hidden>$</span>
                  <input inputMode="decimal" autoComplete="off" value={limitsRaw[key]} aria-invalid={!!err} onChange={(e) => editLimit(key, e.target.value)} />
                </span>
                {err && <span className="field-error">{err}</span>}
              </label>
            );
          })}
        </div>
        {limitsCheck.ok && <p className="ofield-hint">{limitsMeaning(limitsCheck.limits)}</p>}
      </Field>

      <Field label="Services" hint="It can ask you for more later; you approve each one.">
        {dirError && (
          <p className="osheet-row-action osheet-row-warn">
            <Warn width={14} height={14} /> <span>{dirError}</span>
            {adapter && (
              <button type="button" className="btn btn-sm" onClick={() => void loadDirectory(adapter)}>
                Retry
              </button>
            )}
          </p>
        )}
        {!directory && !dirError && <p className="muted">Loading services…</p>}
        {directory && (
          <ul className="ln-group svc-picks">
            <li>
              <label className="grow pick pick-locked" title="Every agent always has the directory">
                <ServiceTile name={dirEntry?.name ?? "Service Directory"} color={dirEntry?.color ?? "#5B7CFA"} size="xs" />
                <span className="grow-main">
                  <span className="grow-title">{dirEntry?.name ?? "Service Directory"}</span>
                </span>
                <span className="grow-meta">Always included</span>
                <input type="checkbox" checked disabled readOnly />
              </label>
            </li>
            {pickable.map((s) => {
              const on = selected.includes(s.id);
              return (
                <li key={s.id}>
                  <label className={`grow pick${on ? " pick-on" : ""}`} title={s.summary}>
                    <ServiceTile name={s.name} color={s.color} size="xs" shopify={isShopifyGrant(s)} />
                    <span className="grow-main">
                      <span className="grow-title">{s.name}</span>
                    </span>
                    <span className="grow-meta">{isShopifyGrant(s) ? capLabel(s.maxPrice) : s.pricing}</span>
                    <input type="checkbox" checked={on} onChange={() => toggleService(s.id)} />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {serviceError && (
          <p className="field-error" role="alert">
            {serviceError}
          </p>
        )}
      </Field>
    </SheetShell>
  );
}
