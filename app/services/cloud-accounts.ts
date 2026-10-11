import client from "./api-client";

/**
 * Cloud Accounts: one consolidated total per cloud billing account.
 *
 * Built for a set of separate GCP accounts (mostly Firebase) where the owner
 * wants a single figure per account, not a per-service breakdown.
 *
 * Three sources, fetched together:
 *  - /cloudCost/status       which accounts are connected, and whether data is arriving
 *  - /cloudCost/view/table   the totals, grouped by billing account (invoiceEntityID)
 *  - cloud-accounts.json     display names and currencies, written at container
 *                            start from the CLOUD_ACCOUNT_NAMES environment variable
 *
 * cloud-accounts.json maps an account ID to either a name, or a name and the
 * currency that account is billed in:
 *   { "012345-6789AB-CDEF01": "Shop",
 *     "123456789012": { "name": "Main AWS", "currency": "USD" } }
 *
 * 🔑 The cost engine has no notion of currency: it passes on the provider's
 * numbers as they are. An account billed in rupees reports rupee amounts. So the
 * currency is configuration, it defaults to USD, and amounts in different
 * currencies are NEVER added together as they are.
 *
 * Display currency (optional). When cloud-display.json names one, e.g.
 *   { "currency": "INR" }
 * every account is ALSO shown converted into it, and the converted amounts are
 * what gets added up. The rates come from fx/latest.json, which nginx fetches
 * from a public reference-rate service and caches; the browser never calls a
 * third party. A converted figure is an approximation: the provider's invoice
 * uses the provider's own rate on its own date.
 *
 * Fixed costs (optional). A subscription with no billing API cannot be fetched,
 * so it is written down instead, under the reserved key "_fixed" in
 * cloud-accounts.json:
 *   { "_fixed": [ { "name": "Team chat", "provider": "Example", "amount": 20,
 *                   "currency": "USD", "from": "2026-01", "to": "2026-12" } ] }
 * amount is PER MONTH. from and to are optional months (YYYY-MM, both
 * inclusive). Each entry is listed like an account and added to the total.
 * 🔑 These exist on this page only: the cost engine never sees them, so they
 * are in none of its reports and none of its API answers.
 *
 * Fixed costs can also be added and changed FROM THE PAGE when the deployment
 * gives the interface somewhere to keep them (FIXED_COSTS_DIR, see
 * docker-entrypoint.sh). They are then one file, store/fixed-costs.json, which
 * nginx serves and accepts back with PUT:
 *   { "fixed": [ ...same entries as above... ] }
 * Entries from configuration and entries saved from the page are both shown;
 * only the saved ones can be edited here.
 */

export const DEFAULT_CURRENCY = "USD";

// "fixed" = not a connection at all: an amount written in configuration.
export type AccountState = "ok" | "waiting" | "failed" | "unknown" | "fixed";

export interface CloudAccount {
  /** Billing account ID as the cloud provider writes it, e.g. 012345-6789AB-CDEF01 */
  id: string;
  /** The name to show: from cloud-accounts.json, else the project ID, else the ID */
  name: string;
  provider: string;
  /** ISO 4217 code this account is billed in. Configuration, not detected. */
  currency: string;
  projectId: string | null;
  state: AccountState;
  /** The provider-side status text, e.g. "Connection Successful" or "Data Missing" */
  statusText: string;
  lastRun: string | null;
  nextRun: string | null;
  /** Month to date. null = no data for this account in that window (NOT zero). */
  thisMonth: number | null;
  lastMonth: number | null;
}

interface StatusRow {
  key: string;
  provider: string;
  connectionStatus: string;
  lastRun?: string;
  nextRun?: string;
  config?: { projectID?: string; table?: string; account?: string };
}

interface TableRow {
  name: string;
  cost: number;
}

/**
 * GCP names its export table after the billing account, with underscores:
 *   gcp_billing_export_resource_v1_012345_6789AB_CDEF01  ->  012345-6789AB-CDEF01
 * That is the only place the status endpoint reveals which billing account an
 * integration belongs to, and it is what the cost rows are keyed by.
 */
export function billingIdFromGcpTable(table: string | undefined): string | null {
  const m = /_v1_([0-9A-Za-z]{6})_([0-9A-Za-z]{6})_([0-9A-Za-z]{6})$/.exec(table ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}`.toUpperCase() : null;
}

/**
 * Which billing account a connected integration belongs to. This is the ID the
 * cost rows are grouped by (invoiceEntityID), so the two can be joined.
 *   GCP  the billing account, recovered from the export table's name
 *   AWS  the account the report belongs to (its own payer unless it sits under
 *        another organisation's management account)
 */
function accountIdOf(s: StatusRow): string {
  return billingIdFromGcpTable(s.config?.table) ?? s.config?.account ?? s.key;
}

function stateOf(status: string): AccountState {
  const s = (status || "").toLowerCase();
  if (s.includes("success")) return "ok";
  if (s.includes("missing") || s.includes("initial") || s.includes("incomplete")) return "waiting";
  if (s.includes("fail") || s.includes("invalid") || s.includes("error")) return "failed";
  return "unknown";
}

async function totals(window: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const resp = await client.get("/cloudCost/view/table", {
    params: {
      window,
      aggregate: "invoiceEntityID",
      // The whole window as one figure per account.
      accumulate: "true",
      // What was actually charged, after credits and discounts.
      costMetric: "netCost",
      limit: 1000,
    },
  });
  for (const row of (resp.data?.data ?? []) as TableRow[]) {
    if (row?.name) out.set(row.name.toUpperCase(), Number(row.cost) || 0);
  }
  return out;
}

interface AccountLabel {
  name?: string;
  currency?: string;
}

const FIXED_KEY = "_fixed";

export interface FixedCost {
  name: string;
  provider: string;
  /** Per month, in `currency`. */
  amount: number;
  currency: string;
  /** First and last month it is charged, YYYY-MM, inclusive. null = open. */
  from: string | null;
  to: string | null;
}

// An entry that is not fully understood is left out. A wrong amount in a total
// is worse than a missing row, which is at least visible.
function fixedCosts(raw: unknown): FixedCost[] {
  if (!Array.isArray(raw)) return [];
  const month = (v: unknown): string | null | undefined =>
    v === undefined || v === null || v === "" ? null : typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : undefined;
  const out: FixedCost[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const amount = o.amount;
    const currency = typeof o.currency === "string" ? o.currency.trim().toUpperCase() : DEFAULT_CURRENCY;
    const from = month(o.from);
    const to = month(o.to);
    if (!name || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) continue;
    if (!/^[A-Z]{3}$/.test(currency) || from === undefined || to === undefined) continue;
    const provider = typeof o.provider === "string" && o.provider.trim() ? o.provider.trim() : "Subscription";
    out.push({ name, provider, amount, currency, from, to });
  }
  return out;
}

/** YYYY-MM of the month `back` months before now, in UTC like the cost windows. */
function monthKey(back: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
}

function chargedIn(f: FixedCost, month: string): boolean {
  return (f.from === null || f.from <= month) && (f.to === null || month <= f.to);
}

async function accountConfig(): Promise<{ labels: Record<string, AccountLabel>; fixed: FixedCost[] }> {
  try {
    // Served by nginx next to the app, NOT through the API proxy. no-store, so
    // a renamed account shows without a hard refresh.
    const resp = await fetch(`${import.meta.env.BASE_URL}cloud-accounts.json`, { cache: "no-store" });
    if (!resp.ok) return { labels: {}, fixed: [] };
    const data = await resp.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return { labels: {}, fixed: [] };
    const labels: Record<string, AccountLabel> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === FIXED_KEY) continue;
      if (typeof v === "string" && v.trim()) {
        labels[k.toUpperCase()] = { name: v.trim() };
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : undefined;
        // Three letters only; anything else is ignored rather than shown.
        const currency =
          typeof o.currency === "string" && /^[A-Za-z]{3}$/.test(o.currency.trim())
            ? o.currency.trim().toUpperCase()
            : undefined;
        if (name || currency) labels[k.toUpperCase()] = { name, currency };
      }
    }
    return { labels, fixed: fixedCosts((data as Record<string, unknown>)[FIXED_KEY]) };
  } catch {
    return { labels: {}, fixed: [] };
  }
}

/** Reference rates, all quoted against one US dollar. */
export interface DisplayRates {
  /** The currency every account is converted into, e.g. INR. */
  currency: string;
  /** The day the rates are for, as the rate service reports it (YYYY-MM-DD). */
  date: string;
  /** Units of each currency per 1 USD. Always contains USD: 1. */
  perUsd: Record<string, number>;
}

/**
 * Convert an amount between two currencies through the dollar.
 * null = one of the two currencies has no rate, so the amount cannot be
 * converted. Callers must then keep it in its own currency, never guess.
 */
export function convert(amount: number, from: string, to: string, perUsd: Record<string, number>): number | null {
  if (from === to) return amount;
  const f = perUsd[from];
  const t = perUsd[to];
  if (!(f > 0) || !(t > 0)) return null;
  return (amount / f) * t;
}

async function displayConfig(): Promise<{ currency: string | null; fixedEditable: boolean }> {
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}cloud-display.json`, { cache: "no-store" });
    if (!resp.ok) return { currency: null, fixedEditable: false };
    const data = await resp.json();
    const c = typeof data?.currency === "string" ? data.currency.trim().toUpperCase() : "";
    return { currency: /^[A-Z]{3}$/.test(c) ? c : null, fixedEditable: data?.fixedCostsEditable === true };
  } catch {
    return { currency: null, fixedEditable: false };
  }
}

const STORE_URL = `${import.meta.env.BASE_URL}store/fixed-costs.json`;

/**
 * The fixed costs saved from the page. Throws when the file cannot be read or
 * is not what this page wrote: the caller must then NOT offer editing, because
 * saving would replace whatever is there with an empty list.
 */
async function savedFixedCosts(): Promise<FixedCost[]> {
  const resp = await fetch(STORE_URL, { cache: "no-store" });
  if (!resp.ok) throw new Error(`the saved fixed costs answered ${resp.status}`);
  const data = await resp.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as { fixed?: unknown }).fixed)) {
    throw new Error("the saved fixed costs are not in the expected shape");
  }
  return fixedCosts((data as { fixed: unknown }).fixed);
}

/** Replace the saved list. The whole list is written each time. */
export async function saveFixedCosts(items: FixedCost[]): Promise<void> {
  // Through the same check as reading: nothing is stored that would not be shown.
  const clean = fixedCosts(items);
  if (clean.length !== items.length) throw new Error("one of the entries is not valid, nothing was saved");
  const resp = await fetch(STORE_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fixed: clean }),
  });
  if (!resp.ok) throw new Error(`saving answered ${resp.status}`);
}

async function ratesPerUsd(): Promise<{ date: string; perUsd: Record<string, number> }> {
  const resp = await fetch(`${import.meta.env.BASE_URL}fx/latest.json`);
  if (!resp.ok) throw new Error(`exchange rates answered ${resp.status}`);
  const data = await resp.json();
  if (data?.base !== "USD" || !data.rates || typeof data.rates !== "object") {
    throw new Error("exchange rates came back in an unexpected shape");
  }
  const perUsd: Record<string, number> = { USD: 1 };
  for (const [code, rate] of Object.entries(data.rates)) {
    // Anything that is not a positive number is dropped, so it can never be
    // multiplied into a total.
    if (/^[A-Z]{3}$/.test(code) && typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      perUsd[code] = rate;
    }
  }
  return { date: typeof data.date === "string" ? data.date : "", perUsd };
}

export interface CloudAccountsResult {
  accounts: CloudAccount[];
  /** Set when the totals could not be fetched at all (as opposed to being empty). */
  totalsError: string | null;
  /** null = no display currency is configured, or its rates could not be had. */
  display: DisplayRates | null;
  /** Set when a display currency IS configured but conversion is not possible. */
  displayError: string | null;
  /** The fixed costs saved from the page. null = editing is not available here. */
  savedFixed: FixedCost[] | null;
  /** Set when editing is switched on but the saved list could not be read. */
  savedFixedError: string | null;
}

export async function fetchCloudAccounts(): Promise<CloudAccountsResult> {
  const [statusResp, config, month, lastMonth, displayCfg] = await Promise.all([
    client.get("/cloudCost/status"),
    accountConfig(),
    totals("month").catch((e) => e as Error),
    totals("lastmonth").catch((e) => e as Error),
    displayConfig(),
  ]);
  const displayCode = displayCfg.currency;

  let savedFixed: FixedCost[] | null = null;
  let savedFixedError: string | null = null;
  if (displayCfg.fixedEditable) {
    try {
      savedFixed = await savedFixedCosts();
    } catch (e) {
      savedFixedError = e instanceof Error ? e.message : "the saved fixed costs could not be read";
    }
  }

  // Rates are only fetched when a display currency is asked for. A failure
  // here must never hide the accounts: the page falls back to own currencies.
  let display: DisplayRates | null = null;
  let displayError: string | null = null;
  if (displayCode) {
    try {
      const r = await ratesPerUsd();
      if (r.perUsd[displayCode] > 0) display = { currency: displayCode, date: r.date, perUsd: r.perUsd };
      else displayError = `no exchange rate is published for ${displayCode}`;
    } catch (e) {
      displayError = e instanceof Error ? e.message : "exchange rates could not be fetched";
    }
  }

  const names = config.labels;
  const monthMap = month instanceof Map ? month : new Map<string, number>();
  const lastMap = lastMonth instanceof Map ? lastMonth : new Map<string, number>();
  const totalsError =
    month instanceof Error ? month.message : lastMonth instanceof Error ? lastMonth.message : null;

  const byId = new Map<string, CloudAccount>();

  // 1. Every connected account, whether or not it has data yet.
  for (const s of (statusResp.data?.data ?? []) as StatusRow[]) {
    const projectId = s.config?.projectID ?? null;
    const id = accountIdOf(s);
    const label = names[id.toUpperCase()] ?? (projectId ? names[projectId.toUpperCase()] : undefined) ?? {};
    byId.set(id.toUpperCase(), {
      id,
      name: label.name ?? projectId ?? id,
      currency: label.currency ?? DEFAULT_CURRENCY,
      provider: s.provider || "Cloud",
      projectId,
      state: stateOf(s.connectionStatus),
      statusText: s.connectionStatus || "Unknown",
      lastRun: s.lastRun ?? null,
      nextRun: s.nextRun ?? null,
      thisMonth: null,
      lastMonth: null,
    });
  }

  // 2. Fill in totals, and add any account that has costs but no status row.
  for (const [map, field] of [[monthMap, "thisMonth"], [lastMap, "lastMonth"]] as const) {
    for (const [id, cost] of map) {
      let acct = byId.get(id);
      if (!acct) {
        acct = {
          id, name: names[id]?.name ?? id, currency: names[id]?.currency ?? DEFAULT_CURRENCY,
          provider: "Cloud", projectId: null, state: "ok",
          statusText: "Has cost data", lastRun: null, nextRun: null, thisMonth: null, lastMonth: null,
        };
        byId.set(id, acct);
      }
      acct[field] = cost;
    }
  }

  // 3. Fixed costs. Listed only for a month they are charged in; one that has
  // ended, or not started, is in neither month and is left out.
  const [thisKey, lastKey] = [monthKey(0), monthKey(1)];
  const addFixed = (list: FixedCost[], kind: string) =>
    list.forEach((f, i) => {
      const thisMonth = chargedIn(f, thisKey) ? f.amount : null;
      const lastMonth = chargedIn(f, lastKey) ? f.amount : null;
      if (thisMonth === null && lastMonth === null) return;
      byId.set(`${FIXED_KEY}:${kind}:${i}`, {
        id: `${kind}-${i + 1}`, name: f.name, currency: f.currency, provider: f.provider, projectId: null,
        state: "fixed", statusText: "Fixed monthly cost", lastRun: null, nextRun: null, thisMonth, lastMonth,
      });
    });
  addFixed(config.fixed, "fixed");
  addFixed(savedFixed ?? [], "saved");

  const accounts = [...byId.values()].sort(
    (a, b) => (b.thisMonth ?? -1) - (a.thisMonth ?? -1) || a.name.localeCompare(b.name),
  );
  return { accounts, totalsError, display, displayError, savedFixed, savedFixedError };
}
