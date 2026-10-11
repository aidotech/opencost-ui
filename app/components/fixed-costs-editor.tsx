import { useState } from "react";
import type { FixedCost } from "~/services/cloud-accounts";

/**
 * Add, change and remove the fixed costs saved from the page.
 *
 * The whole list is saved on every change: there are a handful of entries and
 * one file behind them. Nothing is changed on screen until the save answered,
 * so what is listed is always what is stored.
 */

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED"];

interface Draft {
  name: string;
  provider: string;
  amount: string;
  currency: string;
  from: string;
  to: string;
}

const EMPTY: Draft = { name: "", provider: "", amount: "", currency: "USD", from: "", to: "" };

function toDraft(f: FixedCost): Draft {
  return { name: f.name, provider: f.provider, amount: String(f.amount), currency: f.currency, from: f.from ?? "", to: f.to ?? "" };
}

// Returns the entry, or the reason it cannot be saved.
function fromDraft(d: Draft): FixedCost | string {
  const name = d.name.trim();
  if (!name) return "Give it a name.";
  // An empty amount is refused rather than read as 0: a free plan is typed as 0.
  if (d.amount.trim() === "") return "Enter the monthly amount. Use 0 for a free plan.";
  const amount = Number(d.amount);
  if (!Number.isFinite(amount) || amount < 0) return "The amount must be a number, 0 or more.";
  if (d.from && d.to && d.from > d.to) return "The last month is before the first month.";
  return {
    name,
    provider: d.provider.trim() || "Subscription",
    amount,
    currency: d.currency,
    from: d.from || null,
    to: d.to || null,
  };
}

const field = "w-full rounded-md border px-2 py-1.5 text-sm";
const fieldStyle = { borderColor: "var(--cds-border-subtle)", background: "var(--cds-field-01, #fff)", color: "var(--cds-text-primary)" };
const label = "mb-1 block text-xs font-semibold";

export default function FixedCostsEditor({
  items,
  onSave,
}: {
  items: FixedCost[];
  /** Saves the whole list and reloads. Rejects with the reason when it fails. */
  onSave: (items: FixedCost[]) => Promise<void>;
}) {
  // null = the form is closed. -1 = adding. Otherwise the row being changed.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // Removing takes two clicks on the same row, with no browser dialog.
  const [removing, setRemoving] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (index: number) => {
    setEditing(index);
    setDraft(index === -1 ? EMPTY : toDraft(items[index]));
    setRemoving(null);
    setError(null);
  };

  const commit = async (next: FixedCost[], done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      done();
    } catch (e) {
      setError(`Not saved: ${e instanceof Error ? e.message : "the save failed"}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const entry = fromDraft(draft);
    if (typeof entry === "string") {
      setError(entry);
      return;
    }
    const next = editing === -1 ? [...items, entry] : items.map((f, i) => (i === editing ? entry : f));
    void commit(next, () => setEditing(null));
  };

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  // A currency saved earlier that is not in the short list stays selectable.
  const currencies = CURRENCIES.includes(draft.currency) ? CURRENCIES : [...CURRENCIES, draft.currency];

  return (
    <section
      className="mt-6 rounded-xl border p-4"
      style={{ borderColor: "var(--cds-border-subtle)", background: "var(--cds-layer-01)" }}
      data-testid="fixed-costs-editor"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold" style={{ color: "var(--cds-text-primary)" }}>Fixed costs</h2>
          <p className="text-xs" style={{ color: "var(--cds-text-secondary)" }}>
            Subscriptions that cannot be fetched. Enter the amount for one month; it is counted in full for every month it applies to.
          </p>
        </div>
        {editing === null && (
          <button
            type="button"
            onClick={() => open(-1)}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            style={{ background: "#0E9488" }}
            data-testid="fixed-costs-add"
          >
            Add fixed cost
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-md px-3 py-2 text-sm" style={{ background: "#FEE2E2", color: "#991B1B" }} data-testid="fixed-costs-error">
          {error}
        </div>
      )}

      {items.length === 0 && editing === null && (
        <p className="text-sm" style={{ color: "var(--cds-text-secondary)" }}>None saved yet.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y" style={{ borderColor: "var(--cds-border-subtle)" }}>
          {items.map((f, i) => (
            <li key={`${i}-${f.name}`} className="flex flex-wrap items-center justify-between gap-3 py-2" data-testid="fixed-cost-item">
              <div className="text-sm">
                <span className="font-semibold" style={{ color: "var(--cds-text-primary)" }}>{f.name}</span>
                <span style={{ color: "var(--cds-text-secondary)" }}>
                  {" "}· {f.provider} · {f.amount} {f.currency} a month
                  {f.from ? ` · from ${f.from}` : ""}
                  {f.to ? ` · until ${f.to}` : ""}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => open(i)}
                  disabled={busy}
                  className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60"
                  style={{ borderColor: "var(--cds-border-subtle)", color: "var(--cds-text-primary)" }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (removing !== i) {
                      setRemoving(i);
                      return;
                    }
                    void commit(items.filter((_, j) => j !== i), () => {
                      setRemoving(null);
                      setEditing(null);
                    });
                  }}
                  disabled={busy}
                  className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60"
                  style={removing === i ? { background: "#991B1B", borderColor: "#991B1B", color: "#fff" } : { borderColor: "var(--cds-border-subtle)", color: "#991B1B" }}
                  data-testid="fixed-cost-remove"
                >
                  {removing === i ? "Click again to remove" : "Remove"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <form onSubmit={submit} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6" data-testid="fixed-costs-form">
          <div className="col-span-2">
            <label className={label} htmlFor="fc-name" style={{ color: "var(--cds-text-secondary)" }}>Name</label>
            <input id="fc-name" className={field} style={fieldStyle} value={draft.name} onChange={set("name")} maxLength={60} autoFocus />
          </div>
          <div className="col-span-2">
            <label className={label} htmlFor="fc-provider" style={{ color: "var(--cds-text-secondary)" }}>Provider (optional)</label>
            <input id="fc-provider" className={field} style={fieldStyle} value={draft.provider} onChange={set("provider")} maxLength={40} />
          </div>
          <div>
            <label className={label} htmlFor="fc-amount" style={{ color: "var(--cds-text-secondary)" }}>Per month</label>
            <input id="fc-amount" className={field} style={fieldStyle} value={draft.amount} onChange={set("amount")} inputMode="decimal" />
          </div>
          <div>
            <label className={label} htmlFor="fc-currency" style={{ color: "var(--cds-text-secondary)" }}>Currency</label>
            <select id="fc-currency" className={field} style={fieldStyle} value={draft.currency} onChange={set("currency")}>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className={label} htmlFor="fc-from" style={{ color: "var(--cds-text-secondary)" }}>First month (optional)</label>
            <input id="fc-from" type="month" className={field} style={fieldStyle} value={draft.from} onChange={set("from")} />
          </div>
          <div className="col-span-2">
            <label className={label} htmlFor="fc-to" style={{ color: "var(--cds-text-secondary)" }}>Last month (optional)</label>
            <input id="fc-to" type="month" className={field} style={fieldStyle} value={draft.to} onChange={set("to")} />
          </div>
          <div className="col-span-2 flex items-end gap-2">
            <button type="submit" disabled={busy} className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60" style={{ background: "#0E9488" }} data-testid="fixed-costs-save">
              {busy ? "Saving…" : editing === -1 ? "Add" : "Save"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setEditing(null); setError(null); }}
              className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
              style={{ borderColor: "var(--cds-border-subtle)", color: "var(--cds-text-primary)" }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
