/**
 * Readers for Quantcomm's API (docs/ARCHITECTURE.md §17.1, verified against quantcomm fa347bc).
 *
 * Quantcomm is changing fast, so every field the bridge uses is checked here and nothing else is
 * read. A wrong shape throws `changed(where)`, which the bridge answers with `502 quantcomm_changed`
 * before any payment (fail closed). Pipeline outputs Quantcomm hasn't produced yet come back as
 * `{ available: false, label, hint }`; those are read as `Missing`, not as a change.
 */
import { changed } from "./errors.js";

type Obj = Record<string, unknown>;

// ---- primitives ---------------------------------------------------------------------------------------

function obj(v: unknown, where: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw changed(`${where} is not an object`);
  return v as Obj;
}

function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw changed(`${where} is not an array`);
  return v;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") throw changed(`${where} is not a string`);
  return v;
}

function strOrNull(v: unknown, where: string): string | null {
  return v === null || v === undefined ? null : str(v, where);
}

/** An ISO timestamp the bridge computes with (alert age): unparseable is a change, not "unknown". */
function time(v: unknown, where: string): string {
  const s = str(v, where);
  if (!Number.isFinite(Date.parse(s))) throw changed(`${where} is not a timestamp`);
  return s;
}

function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw changed(`${where} is not a number`);
  return v;
}

function numOrNull(v: unknown, where: string): number | null {
  return v === null || v === undefined ? null : num(v, where);
}

function count(v: unknown, where: string): number {
  const n = num(v, where);
  if (!Number.isInteger(n) || n < 0) throw changed(`${where} is not a count`);
  return n;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw changed(`${where} is not a boolean`);
  return v;
}

function strs(v: unknown, where: string): string[] {
  return arr(v, where).map((x, i) => str(x, `${where}[${i}]`));
}

/** `"Coastal Flood Advisory;Flood Warning"` → both, trimmed; empty or null → []. */
function eventList(v: unknown, where: string): string[] {
  const s = strOrNull(v, where);
  return s ? s.split(";").map((e) => e.trim()).filter(Boolean) : [];
}

/** `{ success: true, data, error }` → data. */
function envelope(json: unknown, what: string): Obj {
  const e = obj(json, `${what}: the response`);
  if (e.success !== true) throw changed(`${what}: success is not true`);
  return obj(e.data, `${what}: data`);
}

// ---- "available: false" blocks --------------------------------------------------------------------------

/** A pipeline output Quantcomm hasn't produced (it says which and how to make it). */
export interface Missing {
  missing: true;
  label: string;
}

export const isMissing = (v: unknown): v is Missing => !!v && typeof v === "object" && (v as Missing).missing === true;

function block(v: unknown, where: string): Obj | Missing {
  const o = obj(v, where);
  if (o.available === false) return { missing: true, label: typeof o.label === "string" && o.label ? o.label : where };
  if (o.available !== true) throw changed(`${where}.available is not a boolean`);
  return o;
}

// ---- GET /api/markets -----------------------------------------------------------------------------------

export interface Company {
  ticker: string;
  name: string;
  group: string;
}

export interface Markets {
  /** Price data date, e.g. "2026-10-16". */
  asOf: string;
  /** The tickers with analyst views, in Quantcomm's order. */
  universe: string[];
  companies: Map<string, Company>;
}

export function readMarkets(json: unknown): Markets {
  const d = envelope(json, "markets");
  const w = (p: string) => `markets: data.${p}`;
  const asOf = str(d.as_of, w("as_of"));
  const universe = strs(d.universe, w("universe"));
  if (!universe.length) throw changed(`${w("universe")} is empty`);
  const wanted = new Set(universe);
  const companies = new Map<string, Company>();
  arr(d.tickers, w("tickers")).forEach((row, i) => {
    const o = obj(row, w(`tickers[${i}]`));
    const ticker = str(o.ticker, w(`tickers[${i}].ticker`));
    if (!wanted.has(ticker)) return;
    companies.set(ticker, { ticker, name: str(o.name, w(`tickers[${i}].name`)), group: str(o.group, w(`tickers[${i}].group`)) });
  });
  for (const t of universe) if (!companies.has(t)) throw changed(`markets: universe ticker ${t} is missing from data.tickers`);
  return { asOf, universe, companies };
}

// ---- GET /api/advice ------------------------------------------------------------------------------------

export interface Pick {
  ticker: string;
  action: string;
  confidence: number;
  reason: string;
}

export interface Forecast {
  horizonDays: number;
  fromDate: string;
  fromPrice: number;
  returnPct: number;
  lowPct: number;
  highPct: number;
}

export interface Analysis {
  view: string;
  expectedMove: string;
  confidence: number;
  headline: string;
  reasoning: string;
  evidence: string[];
  dataGaps: string[];
  /** Only in advice generated by Quantcomm's newest prompt version. */
  forecast?: Forecast;
}

export type Advice =
  | { available: false }
  | {
      available: true;
      /** Quantcomm's data changed since the views were generated. */
      stale: boolean;
      generatedAt: string;
      model: string;
      /** Raw per-ticker entries; read one with `readAnalyst`. */
      analysts: Obj;
      picks: Pick[];
    };

export function readAdvice(json: unknown): Advice {
  const d = envelope(json, "advice");
  const w = (p: string) => `advice: data.${p}`;
  if (!bool(d.available, w("available"))) return { available: false };
  const stale = bool(d.stale, w("stale"));
  const adv = obj(d.advice, w("advice"));
  const generatedAt = time(adv.generated_utc, w("advice.generated_utc"));
  const model = str(adv.model, w("advice.model"));
  const analysts = obj(adv.analysts, w("advice.analysts"));
  // A run whose portfolio manager failed has no portfolio; that is "no picks", not a change.
  const picks: Pick[] = [];
  if (adv.portfolio !== null && adv.portfolio !== undefined) {
    const portfolio = obj(adv.portfolio, w("advice.portfolio"));
    arr(portfolio.picks, w("advice.portfolio.picks")).forEach((p, i) => {
      const at = (k: string) => w(`advice.portfolio.picks[${i}].${k}`);
      const o = obj(p, w(`advice.portfolio.picks[${i}]`));
      picks.push({ ticker: str(o.ticker, at("ticker")), action: str(o.action, at("action")), confidence: num(o.confidence, at("confidence")), reason: str(o.reason, at("reason")) });
    });
  }
  return { available: true, stale, generatedAt, model, analysts, picks };
}

/** The status of one analyst (`"ok"`, `"error"`, …), or undefined when Quantcomm has none for the ticker. */
export function analystStatus(advice: Advice, ticker: string): string | undefined {
  if (!advice.available) return undefined;
  const entry = advice.analysts[ticker];
  if (entry === undefined) return undefined;
  return str(obj(entry, `advice: analysts.${ticker}`).status, `advice: analysts.${ticker}.status`);
}

/** One analyst's view, checked; undefined when there is none or its run failed. */
export function readAnalysis(advice: Advice, ticker: string): Analysis | undefined {
  if (analystStatus(advice, ticker) !== "ok" || !advice.available) return undefined;
  const w = (p: string) => `advice: analysts.${ticker}.analysis${p}`;
  const a = obj(obj(advice.analysts[ticker], w("")).analysis, w(""));
  if (str(a.ticker, w(".ticker")) !== ticker) throw changed(`${w(".ticker")} is ${String(a.ticker)}, not ${ticker}`);
  const out: Analysis = {
    view: str(a.view, w(".view")),
    expectedMove: str(a.expected_move, w(".expected_move")),
    confidence: num(a.confidence, w(".confidence")),
    headline: str(a.headline, w(".headline")),
    reasoning: str(a.reasoning, w(".reasoning")),
    evidence: strs(a.evidence_used, w(".evidence_used")),
    dataGaps: strs(a.data_gaps, w(".data_gaps")),
  };
  if (a.forecast !== undefined && a.forecast !== null) {
    const f = obj(a.forecast, w(".forecast"));
    out.forecast = {
      horizonDays: count(f.horizon_days, w(".forecast.horizon_days")),
      fromDate: str(f.from_date, w(".forecast.from_date")),
      fromPrice: num(f.from_price, w(".forecast.from_price")),
      returnPct: num(f.return_pct, w(".forecast.return_pct")),
      lowPct: num(f.low_pct, w(".forecast.low_pct")),
      highPct: num(f.high_pct, w(".forecast.high_pct")),
    };
  }
  return out;
}

// ---- GET /api/research/{ticker}?panels= -----------------------------------------------------------------

export interface ResearchOption {
  key: string;
  title: string;
  shows: string;
}

export interface Research {
  ticker: string;
  name: string;
  asOf: string | null;
  options: ResearchOption[];
  /** Raw panels by key; read each with the panel readers below. */
  panels: Record<string, Obj>;
}

export function readResearch(json: unknown, ticker: string, requested?: readonly string[]): Research {
  const what = `research ${ticker}`;
  const d = envelope(json, what);
  const w = (p: string) => `${what}: data.${p}`;
  if (str(d.ticker, w("ticker")) !== ticker) throw changed(`${w("ticker")} is ${String(d.ticker)}, not ${ticker}`);
  const options = arr(d.options, w("options")).map((o, i) => {
    const x = obj(o, w(`options[${i}]`));
    return { key: str(x.key, w(`options[${i}].key`)), title: str(x.title, w(`options[${i}].title`)), shows: str(x.shows, w(`options[${i}].shows`)) };
  });
  const rawPanels = obj(d.panels, w("panels"));
  const panels: Record<string, Obj> = {};
  for (const [k, v] of Object.entries(rawPanels)) panels[k] = obj(v, w(`panels.${k}`));
  for (const k of requested ?? options.map((o) => o.key)) if (!panels[k]) throw changed(`${w("panels")} has no ${k}`);
  return { ticker, name: str(d.name, w("name")), asOf: strOrNull(d.as_of, w("as_of")), options, panels };
}

/** Where-prefix for a panel's fields, e.g. `research COF: data.panels.branch_map`. */
export const panelWhere = (ticker: string, key: string) => `research ${ticker}: data.panels.${key}`;

export interface Storm {
  name: string;
  classification: string | null;
  basin: string | null;
  /** NHC `intensity`: maximum sustained wind in knots. */
  windKt: number | null;
}

export interface AlertOverview {
  generatedAt: string | null;
  total: number | null;
  byType: Record<string, number>;
  storms: Storm[];
}

/** `alerts` (in alerts_map, alert_exposure and branch_map): NWS alert counts and active NHC storms. */
export function readAlertOverview(v: unknown, where: string): AlertOverview | Missing {
  const b = block(v, where);
  if (isMissing(b)) return b;
  const byTypeRaw = obj(b.alerts_by_event, `${where}.alerts_by_event`);
  const byType: Record<string, number> = {};
  for (const [k, n] of Object.entries(byTypeRaw)) byType[k] = count(n, `${where}.alerts_by_event.${k}`);
  const storms = arr(b.active_storms, `${where}.active_storms`).map((s, i) => {
    const at = `${where}.active_storms[${i}]`;
    const o = obj(s, at);
    // NHC passes `intensity` as a string of knots ("80"); anything else is reported as unknown.
    const raw = o.intensity;
    const wind = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : null;
    return { name: str(o.name, `${at}.name`), classification: strOrNull(o.classification, `${at}.classification`), basin: strOrNull(o.basin, `${at}.basin`), windKt: wind !== null && Number.isFinite(wind) ? wind : null };
  });
  const total = b.n_alerts_conus === null || b.n_alerts_conus === undefined ? null : count(b.n_alerts_conus, `${where}.n_alerts_conus`);
  const generatedAt = b.generated_utc === null || b.generated_utc === undefined ? null : time(b.generated_utc, `${where}.generated_utc`);
  return { generatedAt, total, byType, storms };
}

export interface BankRow {
  bank: string;
  ticker: string | null;
  branches: number;
  /** FDIC deposits in branches under alerts, in thousands of dollars. */
  depositsInAlertK: number;
  /** Share of the bank's nationwide deposits, in percent (59.89 = 59.89%). */
  exposurePct: number | null;
  alertTypes: string[];
}

export interface Banks {
  /** Banks with at least one branch under an alert. */
  count: number;
  rows: BankRow[];
  /** This research ticker's own rows. */
  tickerRows: BankRow[];
}

function bankRow(v: unknown, where: string): BankRow {
  const o = obj(v, where);
  const ticker = strOrNull(o.ticker, `${where}.ticker`);
  return {
    bank: str(o.bank_name, `${where}.bank_name`),
    ticker: ticker ? ticker : null,
    branches: count(o.n_branches_in_alert, `${where}.n_branches_in_alert`),
    depositsInAlertK: num(o.deposits_in_alert_k, `${where}.deposits_in_alert_k`),
    exposurePct: numOrNull(o.exposure_pct, `${where}.exposure_pct`),
    alertTypes: eventList(o.alert_events, `${where}.alert_events`),
  };
}

/** alert_exposure `banks`. */
export function readBanks(v: unknown, where: string): Banks | Missing {
  const b = block(v, where);
  if (isMissing(b)) return b;
  return {
    count: count(b.n, `${where}.n`),
    rows: arr(b.rows, `${where}.rows`).map((r, i) => bankRow(r, `${where}.rows[${i}]`)),
    tickerRows: arr(b.ticker_rows, `${where}.ticker_rows`).map((r, i) => bankRow(r, `${where}.ticker_rows[${i}]`)),
  };
}

export interface NessieLocation {
  kind: string;
  name: string;
  /** Nessie ATMs come without a city or state (null and ""). */
  city: string | null;
  state: string | null;
  inAlert: boolean;
  alertTypes: string[];
}

export interface NessieAlerts {
  count: number;
  inAlert: number;
  locations: NessieLocation[];
}

/** branch_map `nessie`: Capital One's Nessie sandbox branches and ATMs, and which sit under alerts. */
export function readNessieAlerts(v: unknown, where: string): NessieAlerts | Missing {
  const b = block(v, where);
  if (isMissing(b)) return b;
  const locations = arr(b.locations, `${where}.locations`).map((l, i) => {
    const at = `${where}.locations[${i}]`;
    const o = obj(l, at);
    return {
      kind: str(o.kind, `${at}.kind`),
      name: str(o.name, `${at}.name`),
      city: strOrNull(o.city, `${at}.city`) || null,
      state: strOrNull(o.state, `${at}.state`) || null,
      inAlert: bool(o.in_alert, `${at}.in_alert`),
      alertTypes: eventList(o.alert_events, `${at}.alert_events`),
    };
  });
  return { count: count(b.n, `${where}.n`), inAlert: count(b.n_in_alert, `${where}.n_in_alert`), locations };
}

export interface Stress {
  customers: number | null;
  /** Sum of the groups' exposure at default, dollars; null when Quantcomm sent no groups. */
  exposureAtDefault: number | null;
  baselineExpectedLoss: number | null;
  incrementalExpectedLoss: number | null;
}

function requireSynthetic(o: Obj, where: string): void {
  // The bridge labels these customers SYNTHETIC; it never relabels data Quantcomm doesn't call synthetic.
  if (o.synthetic !== true) throw changed(`${where}.synthetic is not true`);
}

/** customer_stress `stress`: the SYNTHETIC portfolio's storm stress test. */
export function readStress(v: unknown, where: string): Stress | Missing {
  const b = block(v, where);
  if (isMissing(b)) return b;
  requireSynthetic(b, where);
  let ead: number | null = null;
  if (b.groups !== undefined && b.groups !== null) {
    ead = arr(b.groups, `${where}.groups`).reduce<number>((sum, g, i) => sum + num(obj(g, `${where}.groups[${i}]`).ead, `${where}.groups[${i}].ead`), 0);
  }
  return {
    customers: b.n_customers === null || b.n_customers === undefined ? null : count(b.n_customers, `${where}.n_customers`),
    exposureAtDefault: ead,
    baselineExpectedLoss: numOrNull(b.baseline_expected_loss, `${where}.baseline_expected_loss`),
    incrementalExpectedLoss: numOrNull(b.incremental_expected_loss, `${where}.incremental_expected_loss`),
  };
}

export interface LivePortfolio {
  customers: number;
  inAlert: number;
  /** Loan balance of the SYNTHETIC customers under live alerts, dollars. */
  loanInAlert: number | null;
}

/** customer_stress `live`: SYNTHETIC customers and loans under today's alerts. */
export function readLivePortfolio(v: unknown, where: string): LivePortfolio | Missing {
  const b = block(v, where);
  if (isMissing(b)) return b;
  requireSynthetic(b, where);
  return { customers: count(b.n, `${where}.n`), inAlert: count(b.n_in_alert, `${where}.n_in_alert`), loanInAlert: numOrNull(b.loan_in_alert, `${where}.loan_in_alert`) };
}

export interface FloodSummary {
  landfall: string | null;
  /** When the post-storm radar image was taken. */
  eventTime: string | null;
  hoursAfterLandfall: number | null;
  floodedKm2: number | null;
  /** Share of the storm's area of interest the radar covered, percent. */
  coveragePct: number | null;
}

/** flood_map `flood`. */
export function readFlood(v: unknown, where: string): FloodSummary | Missing {
  const b = block(v, where);
  if (isMissing(b)) return b;
  return {
    landfall: strOrNull(b.landfall_utc, `${where}.landfall_utc`),
    eventTime: strOrNull(b.event_time_utc, `${where}.event_time_utc`),
    hoursAfterLandfall: numOrNull(b.hours_landfall_to_event, `${where}.hours_landfall_to_event`),
    floodedKm2: numOrNull(b.flooded_km2, `${where}.flooded_km2`),
    coveragePct: numOrNull(b.coverage_pct, `${where}.coverage_pct`),
  };
}

export interface NessieExposure {
  count: number;
  exposed: number;
  bufferM: number | null;
}

/** flood_map `nessie`: Capital One locations near the mapped flood; null for companies without branches in Nessie. */
export function readNessieExposure(v: unknown, where: string): NessieExposure | Missing | null {
  if (v === null || v === undefined) return null;
  const b = block(v, where);
  if (isMissing(b)) return b;
  return { count: count(b.n, `${where}.n`), exposed: count(b.n_exposed, `${where}.n_exposed`), bufferM: numOrNull(b.buffer_m, `${where}.buffer_m`) };
}

export interface StormHistory {
  bench: string;
  window: string;
  rows: { storm: string; year: number; excessPct: number | null }[];
}

/** storm_history panel. */
export function readStormHistory(p: Obj, where: string): StormHistory {
  return {
    bench: str(p.bench, `${where}.bench`),
    window: str(p.window, `${where}.window`),
    rows: arr(p.rows, `${where}.rows`).map((r, i) => {
      const o = obj(r, `${where}.rows[${i}]`);
      return { storm: str(o.storm, `${where}.rows[${i}].storm`), year: count(o.year, `${where}.rows[${i}].year`), excessPct: numOrNull(o.excess_pct, `${where}.rows[${i}].excess_pct`) };
    }),
  };
}

export interface ParkingLot {
  verdict: { stance: string; reason: string | null } | null;
  metrics: { label: string; value: number | string | null; unit: string | null }[];
  caveats: string[];
}

/** parking_lot panel (retailers' parking-lot activity from radar). */
export function readParkingLot(p: Obj, where: string): ParkingLot {
  let verdict: ParkingLot["verdict"] = null;
  if (p.verdict !== null && p.verdict !== undefined) {
    const v = obj(p.verdict, `${where}.verdict`);
    verdict = { stance: str(v.stance, `${where}.verdict.stance`), reason: strOrNull(v.reason, `${where}.verdict.reason`) };
  }
  const metrics = arr(p.metrics ?? [], `${where}.metrics`).map((m, i) => {
    const at = `${where}.metrics[${i}]`;
    const o = obj(m, at);
    const value = o.value === null || o.value === undefined ? null : typeof o.value === "string" ? o.value : num(o.value, `${at}.value`);
    return { label: str(o.label, `${at}.label`), value, unit: strOrNull(o.unit, `${at}.unit`) || null };
  });
  return { verdict, metrics, caveats: strs(p.caveats ?? [], `${where}.caveats`) };
}

/** A string field of a panel itself (flood_map `name`, customer_stress `storm`). */
export function readPanelString(p: Obj, key: string, where: string): string {
  return str(p[key], `${where}.${key}`);
}
