import type { Metadata } from "next";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData, runAction, type ActionState } from "@/server/auth/page-ctx";
import { getSettings, updateSettings } from "@/server/settings/settings";

export const metadata: Metadata = { title: "Settings" };

const CHANNELS = ["pos", "web", "marketplace", "api"] as const;

async function saveSettings(_: ActionState, form: FormData): Promise<ActionState> {
  "use server";
  return runAction("settings.update", (tx, ctx) => updateSettings(tx, ctx, {
    currency: String(form.get("currency") ?? "").toUpperCase(),
    timezone: String(form.get("timezone") ?? ""),
    reservationTtlSeconds: Math.round(Number(form.get("reservationTtlHours")) * 3600),
    // Blank = the channel uses the default hold (SO-08).
    channelTtlSeconds: Object.fromEntries(CHANNELS.filter((c) => form.get(`ttl.${c}`)).map((c) => [c, Math.round(Number(form.get(`ttl.${c}`)) * 60)])),
    receiptTolerancePct: Number(form.get("receiptTolerancePct")),
    barcodeAliasDays: Number(form.get("barcodeAliasDays")),
  }));
}

export default async function SettingsPage() {
  const res = await pageData(getSettings);
  if ("denied" in res) return <Denied message={res.denied} />;
  const s = res.data;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="h1">Company settings</h1>
      <div className="card">
        <ActionForm action={saveSettings}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">Currency<input name="currency" defaultValue={s.currency} pattern="[A-Za-z]{3}" required className="input" /></label>
            <label className="label">
              Time zone
              <select name="timezone" defaultValue={s.timezone} className="input">
                {["UTC", ...Intl.supportedValuesOf("timeZone")].map((tz) => <option key={tz}>{tz}</option>)}
              </select>
            </label>
            <label className="label">
              Default reservation hold (hours)
              <input name="reservationTtlHours" type="number" min={0.0167} max={720} step="any" defaultValue={s.reservationTtlSeconds / 3600} required className="input" />
            </label>
            {CHANNELS.map((c) => (
              <label key={c} className="label">
                Hold for {c} channel (minutes, blank = default)
                <input name={`ttl.${c}`} type="number" min={1} max={43200} step={1} defaultValue={s.channelTtlSeconds[c] ? s.channelTtlSeconds[c] / 60 : ""} className="input" />
              </label>
            ))}
            <label className="label">
              Receiving over-delivery tolerance (%)
              <input name="receiptTolerancePct" type="number" min={0} max={100} step="0.1" defaultValue={s.receiptTolerancePct} required className="input" />
            </label>
            <label className="label">
              Old barcodes keep scanning for (days)
              <input name="barcodeAliasDays" type="number" min={0} max={365} step={1} defaultValue={s.barcodeAliasDays} required className="input" />
            </label>
          </div>
          <p className="text-xs text-muted">Approval limits are set per role grant on the Roles page.</p>
        </ActionForm>
      </div>
    </div>
  );
}
