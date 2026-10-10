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
 */

export const DEFAULT_CURRENCY = "USD";

export type AccountState = "ok" | "waiting" | "failed" | "unknown";

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

async function accountLabels(): Promise<Record<string, AccountLabel>> {
  try {
    // Served by nginx next to the app, NOT through the API proxy. no-store, so
    // a renamed account shows without a hard refresh.
    const resp = await fetch(`${import.meta.env.BASE_URL}cloud-accounts.json`, { cache: "no-store" });
    if (!resp.ok) return {};
    const data = await resp.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const labels: Record<string, AccountLabel> = {};
    for (const [k, v] of Object.entries(data)) {
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
    return labels;
  } catch {
    return {};
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

async function displayCurrency(): Promise<string | null> {
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}cloud-display.json`, { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    const c = typeof data?.currency === "string" ? data.currency.trim().toUpperCase() : "";
    return /^[A-Z]{3}$/.test(c) ? c : null;
  } catch {
    return null;
  }
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
}

export async function fetchCloudAccounts(): Promise<CloudAccountsResult> {
  const [statusResp, names, month, lastMonth, displayCode] = await Promise.all([
    client.get("/cloudCost/status"),
    accountLabels(),
    totals("month").catch((e) => e as Error),
    totals("lastmonth").catch((e) => e as Error),
    displayCurrency(),
  ]);

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

  const accounts = [...byId.values()].sort(
    (a, b) => (b.thisMonth ?? -1) - (a.thisMonth ?? -1) || a.name.localeCompare(b.name),
  );
  return { accounts, totalsError, display, displayError };
}
