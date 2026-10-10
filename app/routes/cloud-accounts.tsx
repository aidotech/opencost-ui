import { useCallback, useEffect, useState } from "react";
import DashboardAppShell from "~/components/dashboard-app-shell";
import { fetchCloudAccounts, type AccountState, type CloudAccount } from "~/services/cloud-accounts";

/**
 * Cloud Accounts: one row per cloud billing account, one total each.
 *
 * Deliberately not a breakdown. For several small accounts (mostly Firebase),
 * the useful question is "what did each account cost this month", and the
 * answer is one number.
 */

const STATE_STYLE: Record<AccountState, { label: string; bg: string; fg: string }> = {
  ok: { label: "Connected", bg: "#DCFCE7", fg: "#166534" },
  waiting: { label: "Waiting for data", bg: "#FEF3C7", fg: "#92400E" },
  failed: { label: "Connection failed", bg: "#FEE2E2", fg: "#991B1B" },
  unknown: { label: "Unknown", bg: "#E5E7EB", fg: "#374151" },
};

// Each account's amounts are in that account's own billing currency.
// "—" means no data, which is different from a real total of 0.00.
function money(v: number | null, currency: string): string {
  if (v === null) return "—";
  try {
    return v.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 2 });
  } catch {
    // An unknown currency code must not break the page.
    return `${v.toFixed(2)} ${currency}`;
  }
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function CloudAccountsPage() {
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalsError, setTotalsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchCloudAccounts();
      setAccounts(result.accounts);
      setTotalsError(result.totalsError);
      setError(null);
    } catch (e) {
      // Keep whatever was on screen; say plainly that the refresh failed.
      setError(e instanceof Error ? e.message : "Could not load cloud accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Cloud Accounts | OpenCost";
    void load();
  }, [load]);

  const withData = (accounts ?? []).filter((a) => a.thisMonth !== null);
  // One total PER CURRENCY. Adding rupees to dollars would give a number that
  // looks like money and means nothing.
  const totals = new Map<string, number>();
  for (const a of withData) totals.set(a.currency, (totals.get(a.currency) ?? 0) + (a.thisMonth ?? 0));
  const totalLines = [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const waiting = (accounts ?? []).filter((a) => a.state === "waiting").length;

  return (
    <DashboardAppShell pageTitle="Cloud Accounts">
      <div className="mx-auto max-w-5xl px-4 py-6" data-testid="cloud-accounts">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold" style={{ color: "var(--cds-text-primary)" }}>
              Cloud Accounts
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--cds-text-secondary)" }}>
              One total per cloud billing account, in that account's own currency. Figures are what was
              charged, after credits.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            style={{ background: "#0E9488" }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-md px-4 py-3 text-sm" style={{ background: "#FEE2E2", color: "#991B1B" }}>
            Could not load cloud accounts: {error}
          </div>
        )}
        {!error && totalsError && (
          <div role="alert" className="mb-4 rounded-md px-4 py-3 text-sm" style={{ background: "#FEF3C7", color: "#92400E" }}>
            Accounts are listed, but their totals could not be fetched: {totalsError}
          </div>
        )}

        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl p-4 text-white" style={{ background: "linear-gradient(135deg,#0B3954,#0E9488)" }}>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-90">This month, all accounts</div>
            <div className="mt-1 text-3xl font-bold" data-testid="cloud-accounts-total">
              {accounts === null
                ? "…"
                : totalLines.length === 0
                  ? "—"
                  : totalLines.map(([cur, sum]) => <div key={cur}>{money(sum, cur)}</div>)}
            </div>
            <div className="mt-1 text-xs opacity-90">
              {withData.length} of {accounts?.length ?? 0} accounts reporting
            </div>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--cds-border-subtle)", background: "var(--cds-layer-01)" }}>
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--cds-text-secondary)" }}>Accounts connected</div>
            <div className="mt-1 text-3xl font-bold" style={{ color: "var(--cds-text-primary)" }}>{accounts?.length ?? "…"}</div>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--cds-border-subtle)", background: "var(--cds-layer-01)" }}>
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--cds-text-secondary)" }}>Waiting for first data</div>
            <div className="mt-1 text-3xl font-bold" style={{ color: "var(--cds-text-primary)" }}>{accounts === null ? "…" : waiting}</div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--cds-border-subtle)", background: "var(--cds-layer-01)" }}>
          <table className="w-full text-left text-sm">
            <thead>
              <tr style={{ color: "var(--cds-text-secondary)", borderBottom: "1px solid var(--cds-border-subtle)" }}>
                <th className="px-4 py-3 font-semibold">Account</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 text-right font-semibold">This month</th>
                <th className="px-4 py-3 text-right font-semibold">Last month</th>
                <th className="px-4 py-3 font-semibold">Last checked</th>
              </tr>
            </thead>
            <tbody>
              {accounts === null && (
                <tr><td colSpan={5} className="px-4 py-8 text-center" style={{ color: "var(--cds-text-secondary)" }}>Loading…</td></tr>
              )}
              {accounts !== null && accounts.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center" style={{ color: "var(--cds-text-secondary)" }}>
                  No cloud accounts are connected yet.
                </td></tr>
              )}
              {(accounts ?? []).map((a) => {
                const st = STATE_STYLE[a.state];
                return (
                  <tr key={a.id} data-testid="cloud-account-row" style={{ borderBottom: "1px solid var(--cds-border-subtle)" }}>
                    <td className="px-4 py-3">
                      <div className="font-semibold" style={{ color: "var(--cds-text-primary)" }}>{a.name}</div>
                      <div className="text-xs" style={{ color: "var(--cds-text-secondary)" }}>
                        {a.provider}{a.projectId ? ` · ${a.projectId}` : ""} · {a.id}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ background: st.bg, color: st.fg }} title={a.statusText}>
                        {st.label}
                      </span>
                      {a.state === "waiting" && (
                        <div className="mt-1 text-xs" style={{ color: "var(--cds-text-secondary)" }}>
                          The provider has not delivered billing data yet. Next check {when(a.nextRun)}.
                        </div>
                      )}
                      {a.state === "failed" && (
                        <div className="mt-1 text-xs" style={{ color: "#991B1B" }}>{a.statusText}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums" style={{ color: "var(--cds-text-primary)" }}>{money(a.thisMonth, a.currency)}</td>
                    <td className="px-4 py-3 text-right tabular-nums" style={{ color: "var(--cds-text-secondary)" }}>{money(a.lastMonth, a.currency)}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: "var(--cds-text-secondary)" }}>{when(a.lastRun)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs" style={{ color: "var(--cds-text-secondary)" }}>
          A dash means no data for that period, not a zero. A newly connected account only has costs
          from the day its billing export was switched on.
        </p>
      </div>
    </DashboardAppShell>
  );
}
