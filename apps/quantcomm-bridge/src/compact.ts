/**
 * Compact response shapes (docs/ARCHITECTURE.md §17.1): what an agent pays for, small enough for a
 * model's context. Dollars are converted from Quantcomm's thousands and rounded; geometry and long
 * location lists are dropped. Quantcomm's caveats travel with the data. Nothing is invented: a value
 * Quantcomm didn't send is null (or the field is omitted) and a note says why.
 */
import {
  isMissing,
  readAlertOverview,
  readBanks,
  readFlood,
  readLivePortfolio,
  readNessieAlerts,
  readNessieExposure,
  readPanelString,
  readParkingLot,
  readStormHistory,
  readStress,
  type AlertOverview,
  type Analysis,
  type BankRow,
  type Company,
  type Missing,
  type NessieAlerts,
  type Pick,
} from "./shapes.js";

export const SOURCE = "NWS alerts, FDIC deposits and Capital One Nessie locations via Quantcomm";
export const CAPITAL_ONE_NOTE = "Capital One's Nessie sandbox branches and ATMs (MD/VA/DC)";
export const SYNTHETIC_NOTE = "SYNTHETIC customers: a made-up Capital One portfolio Quantcomm uses for stress tests, not real customers or loans.";
export const DISCLAIMER = "Quantcomm's AI analyst view, for research. Not financial advice.";
export const STALE_VIEW_NOTE = "Quantcomm's data changed since this view was generated.";
/** Alerts older than this carry a note. */
export const ALERTS_STALE_HOURS = 6;
export const MAX_TOP_BANKS = 10;
export const MAX_COMPANY_TOP_BANKS = 5;
export const MAX_LOCATIONS = 10;

// ---- formatting ---------------------------------------------------------------------------------------

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Dollars, short: $11.27B, $23.36M, $438.0K, $195.37. */
export function usd(dollars: number): string {
  const sign = dollars < 0 ? "-" : "";
  const a = Math.abs(dollars);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(2)}`;
}

/** FDIC deposits come in thousands of dollars. */
export const usdFromThousands = (k: number): string => usd(k * 1000);

/** 59.8946 → "59.9%", 0.3537 → "0.35%". */
export function percent(p: number): string {
  return Math.abs(p) >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`;
}

export function ageHours(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, round((now - t) / 3_600_000, 1)) : null;
}

export function alertAgeNote(age: number | null): string | undefined {
  if (age === null) return "Quantcomm didn't say when these alerts were fetched, so their age is unknown.";
  return age > ALERTS_STALE_HOURS ? `Alerts are ${age} hours old.` : undefined;
}

export const missingNote = (m: Missing, what: string): string => `Quantcomm hasn't produced ${what} yet (${m.label}).`;

const titleCase = (s: string) => s.replace(/(^|[\s_-])([a-z])/g, (_m, sep: string, c: string) => `${sep === "_" ? " " : sep}${c.toUpperCase()}`);

// ---- blocks shared by /alerts and /flood --------------------------------------------------------------

export interface AlertsBlock {
  asOf: string | null;
  ageHours: number | null;
  alerts: { total: number | null; byType: Record<string, number> };
  activeStorms: { name: string; classification: string | null; basin: string | null; windKt: number | null }[];
  note?: string;
}

export function alertsBlock(o: AlertOverview, now: number): AlertsBlock {
  const age = ageHours(o.generatedAt, now);
  const note = alertAgeNote(age);
  return {
    asOf: o.generatedAt,
    ageHours: age,
    alerts: { total: o.total, byType: { ...o.byType } },
    activeStorms: o.storms.map((s) => ({ name: s.name, classification: s.classification, basin: s.basin, windKt: s.windKt })),
    ...(note ? { note } : {}),
  };
}

export interface BankExposure {
  bank: string;
  ticker?: string;
  branches: number;
  depositsUnderAlert: string;
  shareOfDeposits: string | null;
  alertTypes: string[];
}

export function bankExposure(r: BankRow): BankExposure {
  return {
    bank: r.bank,
    ...(r.ticker ? { ticker: r.ticker } : {}),
    branches: r.branches,
    depositsUnderAlert: usdFromThousands(r.depositsInAlertK),
    shareOfDeposits: r.exposurePct === null ? null : percent(r.exposurePct),
    alertTypes: r.alertTypes,
  };
}

/** Largest deposits under alerts first (Quantcomm sorts the same way; the bridge doesn't rely on it). */
export function topBanks(rows: BankRow[], n: number): BankExposure[] {
  return [...rows].sort((a, b) => b.depositsInAlertK - a.depositsInAlertK).slice(0, n).map(bankExposure);
}

export interface CapitalOneBlock {
  locationsChecked: number;
  underAlert: number;
  locations: { kind: string; name: string; city: string | null; state: string | null; alertTypes: string[] }[];
  note: string;
}

export function capitalOneBlock(n: NessieAlerts): CapitalOneBlock {
  return {
    locationsChecked: n.count,
    underAlert: n.inAlert,
    locations: n.locations
      .filter((l) => l.inAlert)
      .slice(0, MAX_LOCATIONS)
      .map((l) => ({ kind: l.kind, name: l.name, city: l.city, state: l.state, alertTypes: l.alertTypes })),
    note: CAPITAL_ONE_NOTE,
  };
}

// ---- /flood panels --------------------------------------------------------------------------------------

/** The flood research panels the bridge knows how to read. */
export const PANEL_KEYS = ["branch_map", "customer_stress", "flood_map", "alert_exposure", "alerts_map", "parking_lot", "storm_history"] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];
export const isPanelKey = (k: string): k is PanelKey => (PANEL_KEYS as readonly string[]).includes(k);

/** A compact panel, or null with the notes that say why. `notes` also carries caveats worth surfacing once. */
export interface PanelResult {
  value: Record<string, unknown> | null;
  notes: string[];
}

type Panel = Record<string, unknown>;

export function compactPanel(key: PanelKey, panel: Panel, where: string, now: number): PanelResult {
  switch (key) {
    case "branch_map":
      return branchMapPanel(panel, where, now);
    case "customer_stress":
      return customerStressPanel(panel, where);
    case "flood_map":
      return floodMapPanel(panel, where);
    case "alert_exposure":
      return alertExposurePanel(panel, where, now);
    case "alerts_map":
      return alertsMapPanel(panel, where, now);
    case "parking_lot":
      return { value: { ...readParkingLot(panel, where) }, notes: [] };
    case "storm_history":
      return { value: stormHistoryPanel(panel, where), notes: [] };
  }
}

/** asOf/ageHours of the alerts an alert-based panel was computed from (and the age note, once, at the top). */
function alertAge(v: unknown, where: string, now: number): { fields: { asOf: string | null; ageHours: number | null }; notes: string[] } {
  const o = readAlertOverview(v, where);
  if (isMissing(o)) return { fields: { asOf: null, ageHours: null }, notes: [missingNote(o, "the live alert summary")] };
  const age = ageHours(o.generatedAt, now);
  const note = alertAgeNote(age);
  return { fields: { asOf: o.generatedAt, ageHours: age }, notes: note ? [note] : [] };
}

function branchMapPanel(p: Panel, where: string, now: number): PanelResult {
  const nessie = readNessieAlerts(p.nessie, `${where}.nessie`);
  if (isMissing(nessie)) return { value: null, notes: [missingNote(nessie, "Capital One's branch and ATM check")] };
  const age = alertAge(p.alerts, `${where}.alerts`, now);
  return { value: { ...capitalOneBlock(nessie), ...age.fields }, notes: age.notes };
}

function customerStressPanel(p: Panel, where: string): PanelResult {
  const storm = titleCase(readPanelString(p, "storm", where));
  const stress = readStress(p.stress, `${where}.stress`);
  const live = readLivePortfolio(p.live, `${where}.live`);
  const notes: string[] = [];
  if (isMissing(stress)) notes.push(missingNote(stress, `the ${storm} stress test`));
  if (isMissing(live)) notes.push(missingNote(live, "the live check of SYNTHETIC customers under alerts"));
  if (isMissing(stress) && isMissing(live)) return { value: null, notes };
  const s = isMissing(stress) ? null : stress;
  const l = isMissing(live) ? null : live;
  const money = (n: number | null | undefined) => (n === null || n === undefined ? null : usd(n));
  return {
    value: {
      synthetic: true,
      storm,
      customers: s ? s.customers : null,
      exposureAtDefault: money(s?.exposureAtDefault),
      baselineExpectedLoss: money(s?.baselineExpectedLoss),
      incrementalExpectedLoss: money(s?.incrementalExpectedLoss),
      liveCustomersUnderAlert: l ? l.inAlert : null,
      liveLoansUnderAlert: money(l?.loanInAlert),
      note: SYNTHETIC_NOTE,
    },
    notes,
  };
}

function floodMapPanel(p: Panel, where: string): PanelResult {
  const storm = readPanelString(p, "name", where);
  const flood = readFlood(p.flood, `${where}.flood`);
  if (isMissing(flood)) return { value: null, notes: [missingNote(flood, `the ${storm} flood map`)] };
  const nessie = readNessieExposure(p.nessie, `${where}.nessie`);
  const notes: string[] = [];
  const value: Record<string, unknown> = {
    storm,
    landfall: flood.landfall,
    firstImagePublished: flood.eventTime,
    hoursAfterLandfall: flood.hoursAfterLandfall,
    floodedKm2: flood.floodedKm2,
    coveragePct: flood.coveragePct,
  };
  let note = "Flooding detected by Sentinel-1 satellite radar; coveragePct is the share of the storm area the radar covered.";
  if (nessie && isMissing(nessie)) notes.push(missingNote(nessie, `Capital One's ${storm} exposure`));
  else if (nessie) {
    value.capitalOneLocationsExposed = `${nessie.exposed} of ${nessie.count}`;
    note += ` capitalOneLocationsExposed counts Capital One sandbox locations${nessie.bufferM !== null ? ` within ${nessie.bufferM} m of` : " near"} the mapped flooding.`;
  }
  value.note = note;
  return { value, notes };
}

function alertExposurePanel(p: Panel, where: string, now: number): PanelResult {
  const banks = readBanks(p.banks, `${where}.banks`);
  if (isMissing(banks)) return { value: null, notes: [missingNote(banks, "bank deposits under alerts")] };
  const age = alertAge(p.alerts, `${where}.alerts`, now);
  return { value: { company: banks.tickerRows.map(bankExposure), top: topBanks(banks.rows, MAX_COMPANY_TOP_BANKS), banksUnderAlerts: banks.count, ...age.fields }, notes: age.notes };
}

function alertsMapPanel(p: Panel, where: string, now: number): PanelResult {
  const o = readAlertOverview(p.alerts, `${where}.alerts`);
  if (isMissing(o)) return { value: null, notes: [missingNote(o, "the live alert summary")] };
  const block = alertsBlock(o, now);
  return { value: { ...block }, notes: block.note ? [block.note] : [] };
}

function stormHistoryPanel(p: Panel, where: string): Record<string, unknown> {
  const h = readStormHistory(p, where);
  const known = h.rows.map((r) => r.excessPct).filter((x): x is number => x !== null);
  const mean = known.length ? round(known.reduce((a, b) => a + b, 0) / known.length, 2) : null;
  return {
    bench: h.bench,
    window: h.window,
    storms: h.rows.map((r) => ({ storm: r.storm, year: r.year, excessPct: r.excessPct === null ? null : round(r.excessPct, 2) })),
    meanExcessPct: mean,
    underperformed: `${known.filter((x) => x < 0).length} of ${known.length}`,
  };
}

// ---- /view ----------------------------------------------------------------------------------------------

export interface ViewBody {
  ticker: string;
  name: string;
  generatedAt: string;
  model: string;
  stale: boolean;
  view: string;
  expectedMove: string;
  confidence: number;
  headline: string;
  reasoning: string;
  evidence: string[];
  dataGaps: string[];
  forecast?: { horizonDays: number; fromDate: string; fromPrice: number; returnPct: number; lowPct: number; highPct: number };
  pick?: { action: string; confidence: number; reason: string };
  disclaimer: string;
  note?: string;
}

export function viewBody(company: Company, run: { generatedAt: string; model: string; stale: boolean }, a: Analysis, pick: Pick | undefined): ViewBody {
  return {
    ticker: company.ticker,
    name: company.name,
    generatedAt: run.generatedAt,
    model: run.model,
    stale: run.stale,
    view: a.view,
    expectedMove: a.expectedMove,
    confidence: a.confidence,
    headline: a.headline,
    reasoning: a.reasoning,
    evidence: a.evidence,
    dataGaps: a.dataGaps,
    ...(a.forecast ? { forecast: { ...a.forecast } } : {}),
    ...(pick ? { pick: { action: pick.action, confidence: pick.confidence, reason: pick.reason } } : {}),
    disclaimer: DISCLAIMER,
    ...(run.stale ? { note: STALE_VIEW_NOTE } : {}),
  };
}
