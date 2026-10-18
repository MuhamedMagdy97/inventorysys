import { EVENT_TYPES } from "@/server/webhooks/webhooks";

export function EndpointFields({ url = "", description = "", events = [] as string[] }) {
  return (
    <>
      <label className="label">URL<input name="url" type="url" required defaultValue={url} placeholder="https://example.com/hooks/inventory" className="input" /></label>
      <label className="label">Description<input name="description" maxLength={200} defaultValue={description ?? ""} className="input" /></label>
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="mb-1 text-sm font-medium">Events</legend>
        {EVENT_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-2"><input type="checkbox" name="events" value={t} defaultChecked={events.includes(t)} /><span className="font-mono text-xs">{t}</span></label>
        ))}
      </fieldset>
    </>
  );
}
