import { useEffect, useState } from "react";
import { Amount, money } from "~/components/cloud-amount";
import { convert, type DisplayRates } from "~/services/cloud-accounts";
import {
  BREAKDOWN_WINDOWS,
  fetchNodeNames,
  fetchResources,
  fetchServices,
  serviceLabel,
  shortResourceId,
  type BreakdownWindow,
  type NodeInfo,
  type ResourceCost,
  type ServiceCost,
} from "~/services/cloud-account-breakdown";

/**
 * Opens under an account on the Cloud Accounts page: the account's services,
 * and inside a service, its resources. Largest first. (OP-16)
 */

// Enough to see what is spending the money; the rest is one click away.
const FIRST_RESOURCES = 15;

const secondary = { color: "var(--cds-text-secondary)" };
const primary = { color: "var(--cds-text-primary)" };

// The share of the list's total, as a bar behind nothing: a plain strip.
function Share({ part, whole }: { part: number; whole: number }) {
  const pct = whole > 0 && part > 0 ? Math.min(100, (part / whole) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full" style={{ background: "var(--cds-border-subtle)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "#0E9488" }} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums" style={secondary}>
        {pct >= 0.5 ? `${pct.toFixed(0)}%` : pct > 0 ? "<1%" : "0%"}
      </span>
    </div>
  );
}

function Resources({
  accountId, service, window, currency, display, nodes,
}: {
  accountId: string; service: string; window: BreakdownWindow; currency: string;
  display: DisplayRates | null; nodes: Map<string, NodeInfo>;
}) {
  const [rows, setRows] = useState<ResourceCost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    setAll(false);
    fetchResources(accountId, service, window)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : "could not be fetched"));
    return () => {
      live = false;
    };
  }, [accountId, service, window]);

  if (error) return <div className="px-4 py-3 text-sm" style={{ color: "#991B1B" }}>The resources could not be fetched: {error}</div>;
  if (rows === null) return <div className="px-4 py-3 text-sm" style={secondary}>Loading…</div>;
  if (rows.length === 0) return <div className="px-4 py-3 text-sm" style={secondary}>No resources are listed for this service in this period.</div>;

  const whole = rows.reduce((s, r) => s + Math.max(0, r.cost), 0);
  const shown = all ? rows : rows.slice(0, FIRST_RESOURCES);
  const rest = rows.slice(shown.length);

  return (
    <div data-testid="cloud-breakdown-resources">
      <table className="w-full text-left text-sm">
        <tbody>
          {shown.map((r) => {
            const node = nodes.get(r.id);
            const tags = Object.entries(r.labels);
            return (
              <tr key={r.id || "(none)"} data-testid="cloud-breakdown-resource" style={{ borderTop: "1px solid var(--cds-border-subtle)" }}>
                <td className="py-2 pl-10 pr-4">
                  <div className="break-all font-mono text-xs" style={primary} title={r.id}>
                    {r.id ? shortResourceId(r.id) : "Not tied to one resource"}
                  </div>
                  <div className="text-xs" style={secondary}>
                    {node
                      ? `Cluster node ${node.name}${node.instanceType ? ` · ${node.instanceType}` : ""}${node.capacity ? ` · ${node.capacity}` : ""}`
                      : !r.id
                        ? "Charges the bill does not attach to a resource, such as data transfer or tax"
                        : /^i-[0-9a-f]+$/.test(r.id)
                          ? "Server, not known to the cluster"
                          : ""}
                    {tags.length > 0 && `${node || !r.id || /^i-[0-9a-f]+$/.test(r.id) ? " · " : ""}${tags.map(([k, v]) => `${k}: ${v}`).join(", ")}`}
                  </div>
                </td>
                <td className="px-4 py-2"><Share part={r.cost} whole={whole} /></td>
                <td className="px-4 py-2 text-right tabular-nums" style={primary}>
                  <Amount value={r.cost} currency={currency} display={display} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-0 bg-transparent py-2 pl-10 pr-4 text-left text-xs font-medium underline"
          style={{ ...secondary, borderTop: "1px solid var(--cds-border-subtle)" }}
          data-testid="cloud-breakdown-show-all"
        >
          Show {rest.length} more, <Amount value={rest.reduce((s, r) => s + r.cost, 0)} currency={currency} display={null} /> together
        </button>
      )}
    </div>
  );
}

export default function CloudAccountBreakdown({
  accountId, accountName, currency, display,
}: {
  accountId: string; accountName: string; currency: string; display: DisplayRates | null;
}) {
  const [window, setWindow] = useState<BreakdownWindow>("month");
  const [services, setServices] = useState<ServiceCost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Map<string, NodeInfo>>(new Map());
  // The service whose resources are open. One at a time.
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setServices(null);
    setError(null);
    fetchServices(accountId, window)
      .then((r) => live && setServices(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : "could not be fetched"));
    void fetchNodeNames(window).then((n) => live && setNodes(n));
    return () => {
      live = false;
    };
  }, [accountId, window]);

  // Services that cost nothing in the period are counted, not listed.
  const charged = (services ?? []).filter((s) => Math.abs(s.cost) >= 0.005);
  const free = (services?.length ?? 0) - charged.length;
  const whole = charged.reduce((s, r) => s + Math.max(0, r.cost), 0);
  const total = (services ?? []).reduce((s, r) => s + r.cost, 0);
  // The heading's total follows the page's currency switch, like the rows do.
  const shownTotal = display ? convert(total, currency, display.currency, display.perUsd) : null;

  return (
    <div className="px-4 py-4" style={{ background: "var(--cds-background)" }} data-testid="cloud-breakdown">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold" style={primary}>
          What {accountName} spent on
          {services !== null && (
            <span className="ml-2 font-normal" style={secondary} data-testid="cloud-breakdown-total">
              {shownTotal !== null && display ? money(shownTotal, display.currency) : money(total, currency)} in this period
            </span>
          )}
        </div>
        <div role="group" aria-label="Period" className="inline-flex overflow-hidden rounded-md border text-xs" style={{ borderColor: "var(--cds-border-subtle)" }}>
          {BREAKDOWN_WINDOWS.map((w) => {
            const on = w.value === window;
            return (
              <button
                key={w.value}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setWindow(w.value);
                  setOpen(null);
                }}
                className="px-2.5 py-1 font-medium"
                style={on ? { background: "#0B3954", color: "#fff" } : { background: "var(--cds-layer-01)", color: "var(--cds-text-primary)" }}
              >
                {w.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && <div className="text-sm" style={{ color: "#991B1B" }}>The services could not be fetched: {error}</div>}
      {!error && services === null && <div className="text-sm" style={secondary}>Loading…</div>}
      {!error && services !== null && charged.length === 0 && (
        <div className="text-sm" style={secondary}>
          {services.length === 0 ? "No costs are recorded for this account in this period." : "Nothing was charged in this period."}
        </div>
      )}

      {charged.length > 0 && (
        <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--cds-border-subtle)", background: "var(--cds-layer-01)" }}>
          {charged.map((s, i) => {
            const isOpen = open === s.name;
            const label = serviceLabel(s.name);
            return (
              <div key={s.name} style={i > 0 ? { borderTop: "1px solid var(--cds-border-subtle)" } : undefined}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : s.name)}
                  className="flex w-full items-center gap-3 border-0 bg-transparent px-4 py-2.5 text-left text-sm"
                  data-testid="cloud-breakdown-service"
                >
                  <span aria-hidden="true" className="w-3 text-xs" style={secondary}>{isOpen ? "▾" : "▸"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium" style={primary}>{label ?? s.name}</span>
                    {label && <span className="ml-2 text-xs" style={secondary}>{s.name}</span>}
                  </span>
                  <Share part={s.cost} whole={whole} />
                  <span className="w-32 text-right font-semibold tabular-nums" style={primary}>
                    <Amount value={s.cost} currency={currency} display={display} />
                  </span>
                </button>
                {isOpen && (
                  <Resources accountId={accountId} service={s.name} window={window} currency={currency} display={display} nodes={nodes} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {free > 0 && (
        <p className="mt-2 text-xs" style={secondary}>
          {free} more {free === 1 ? "service was" : "services were"} used and cost nothing in this period.
        </p>
      )}
    </div>
  );
}
