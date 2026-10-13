import { convert, type DisplayRates } from "~/services/cloud-accounts";

// Each account's amounts are in that account's own billing currency.
// "—" means no data, which is different from a real total of 0.00.
export function money(v: number | null, currency: string): string {
  if (v === null) return "—";
  try {
    return v.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 2 });
  } catch {
    // An unknown currency code must not break the page.
    return `${v.toFixed(2)} ${currency}`;
  }
}

// One amount cell. With a display currency, the converted figure leads and the
// amount the provider actually charged stays visible under it. An account whose
// currency has no rate is shown in its own currency only, never guessed.
export function Amount({ value, currency, display }: { value: number | null; currency: string; display: DisplayRates | null }) {
  if (value === null || !display || currency === display.currency) return <>{money(value, currency)}</>;
  const converted = convert(value, currency, display.currency, display.perUsd);
  if (converted === null) return <>{money(value, currency)}</>;
  return (
    <>
      <div>{money(converted, display.currency)}</div>
      <div className="text-xs font-normal" style={{ color: "var(--cds-text-secondary)" }} data-testid="cloud-account-original">
        {money(value, currency)}
      </div>
    </>
  );
}
