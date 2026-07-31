/**
 * Advisory capability-drop toast (deduped once per capability+model).
 *
 * `resolveSendOptions` flags `droppedCapabilityWarning` on a send when the
 * user requested a feature (currently the reasoning `effort` level) that the
 * resolved model does not support per its models.dev metadata, so the
 * parameter was silently dropped to avoid a provider 400. The drop is
 * intentional — the send proceeds — so the only UX is a polite, non-spammy
 * warning. Dedupe lives here (module scope) so the build-options layer stays
 * pure, mirroring `over-budget-toast.ts`.
 */

import { toast } from "sonner"

export interface DroppedCapabilityWarning {
  capability: "effort"
  model: string
  provider?: string
}

const shownKeys = new Set<string>()

/**
 * Show the dropped-capability toast at most once per `${capability}|${model}`.
 * Returns true when a toast was actually shown. `translate` receives the
 * formatted values so the caller binds its own next-intl scope.
 */
export function notifyDroppedCapabilityOnce(
  warning: DroppedCapabilityWarning | undefined,
  translate: (values: { model: string }) => string
): boolean {
  if (!warning) return false
  const key = `${warning.capability}|${warning.model}`
  if (shownKeys.has(key)) return false
  shownKeys.add(key)
  try {
    toast.warning(translate({ model: warning.model }), { duration: 6000 })
  } catch {
    // Toast failures are non-fatal.
  }
  return true
}

export function __resetDroppedCapabilityToastForTesting(): void {
  shownKeys.clear()
}
