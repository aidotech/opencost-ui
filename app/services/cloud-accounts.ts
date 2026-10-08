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
 *  - cloud-accounts.json     display names, written at container start from the
 *                            CLOUD_ACCOUNT_NAMES environment variable
 */

export type AccountState = "ok" | "waiting" | "failed" | "unknown";

export interface CloudAccount {
  /** Billing account ID as the cloud provider writes it, e.g. 012345-6789AB-CDEF01 */
  id: string;
  /** The name to show: from cloud-accounts.json, else the project ID, else the ID */
  name: string;
  provider: string;
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
  config?: { projectID?: string; table?: string };
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

async function displayNames(): Promise<Record<string, string>> {
  try {
    // Served by nginx next to the app, NOT through the API proxy. no-store, so
    // a renamed account shows without a hard refresh.
    const resp = await fetch(`${import.meta.env.BASE_URL}cloud-accounts.json`, { cache: "no-store" });
    if (!resp.ok) return {};
    const data = await resp.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string" && v.trim()) names[k.toUpperCase()] = v.trim();
    }
    return names;
  } catch {
    return {};
  }
}

export interface CloudAccountsResult {
  accounts: CloudAccount[];
  /** Set when the totals could not be fetched at all (as opposed to being empty). */
  totalsError: string | null;
}

export async function fetchCloudAccounts(): Promise<CloudAccountsResult> {
  const [statusResp, names, month, lastMonth] = await Promise.all([
    client.get("/cloudCost/status"),
    displayNames(),
    totals("month").catch((e) => e as Error),
    totals("lastmonth").catch((e) => e as Error),
  ]);

  const monthMap = month instanceof Map ? month : new Map<string, number>();
  const lastMap = lastMonth instanceof Map ? lastMonth : new Map<string, number>();
  const totalsError =
    month instanceof Error ? month.message : lastMonth instanceof Error ? lastMonth.message : null;

  const byId = new Map<string, CloudAccount>();

  // 1. Every connected account, whether or not it has data yet.
  for (const s of (statusResp.data?.data ?? []) as StatusRow[]) {
    const projectId = s.config?.projectID ?? null;
    const id = billingIdFromGcpTable(s.config?.table) ?? s.key;
    byId.set(id.toUpperCase(), {
      id,
      name: names[id.toUpperCase()] ?? (projectId ? names[projectId.toUpperCase()] : undefined) ?? projectId ?? id,
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
          id, name: names[id] ?? id, provider: "Cloud", projectId: null, state: "ok",
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
  return { accounts, totalsError };
}
