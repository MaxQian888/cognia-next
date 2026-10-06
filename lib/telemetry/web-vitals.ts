import type { TelemetryEventCatalog } from "./events/catalog"
import { trackEvent } from "./events/track-event"

/** Already-normalized measurements; browser entries and attribution are never exported. */
export type ReportableWebVital = TelemetryEventCatalog["app.web_vital"]

export function reportWebVital(
  metric: ReportableWebVital,
  options: { signal: AbortSignal }
): Promise<boolean> {
  // Explicit projection prevents browser entry/DOM data from escaping when a
  // caller passes a richer object than the declared TypeScript interface.
  return trackEvent(
    "app.web_vital",
    {
      name: metric.name,
      id: metric.id,
      value: metric.value,
      delta: metric.delta,
      rating: metric.rating,
      navigationType: metric.navigationType,
      route: metric.route,
      runtime: metric.runtime,
      appVersion: metric.appVersion,
    },
    { signal: options.signal, flushImmediately: true }
  )
}
