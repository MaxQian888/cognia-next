/**
 * Mirror a local settings edit up to the paired host.
 *
 * A paired client (Capacitor phone, or a browser pointed at a cloud
 * `cognia-server`) keeps its own `AppSettings` singleton. Editing a setting has
 * to do two things: write it locally so the UI updates immediately and the
 * standalone engine sees it, and enqueue an `app_settings_update` so the host
 * applies the same change when it is reachable.
 *
 * Only the second half used to be anyone's job in particular, so it was done
 * per-page: `hooks/use-settings-patch.ts` did both steps and nine `/me/*` pages
 * called it. Every mobile route that instead **embeds a desktop settings
 * section** — `/me/appearance` renders the desktop `<AppearanceSection />` — went
 * straight to `useSettingsStore`, which only ever wrote locally. So the phone's
 * theme, custom themes, accent colour, custom CSS and imported VSCode themes
 * never reached the desktop, no matter how long you waited. The server-side
 * allowlist had thirteen keys added specifically to stop those tabs from
 * 400-ing, and not one of them was ever exercised.
 *
 * `wallpapers` was in that list too and is no longer: it is an array of
 * references into one machine's storage (a `disk` path under that Tauri host's
 * appData, or an `indexeddb` key in that webview's blob store), and off Tauri
 * `saveImage()` can only produce the latter. Mirroring it filled the desktop's
 * gallery with rows it could not open. It is `device-local` now, so it is
 * dropped here like any other non-writable key.
 *
 * Hanging the mirror off the single persistence funnel (`saveSettings`) instead
 * of off each page fixes every embedded section at once, and means the next
 * reused desktop section is correct on arrival rather than one more silent gap.
 */

import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import type { AppSettings } from "@cognia/agent-config-types"
import { MOBILE_WRITABLE_SETTING_KEYS } from "@cognia/agent-config-types/settings-sync"

const WRITABLE = new Set<string>(MOBILE_WRITABLE_SETTING_KEYS as readonly string[])

/**
 * True when this runtime's settings row is a *mirror* of some host's rather
 * than the authority.
 *
 * The desktop is the authority for its own row, so it never mirrors — including
 * a desktop driving a remote host (ADR-0082), whose local preferences are still
 * its own. An unpaired standalone phone matches, which is harmless: the job
 * simply sits in the queue until a host exists, exactly as the outbound queue is
 * designed to behave.
 */
export function isMirroredSettingsClient(): boolean {
  return isCapacitor() || hasWebCompanionTarget()
}

/**
 * Enqueue the host-writable subset of `patch`. Returns the keys enqueued (empty
 * when there was nothing to send), which is what the tests assert on.
 *
 * Non-writable keys are dropped rather than sent-and-rejected: the host answers
 * a disallowed key with `400 validation_failed` for the whole patch, so posting
 * a mixed patch would lose the writable half too.
 */
export async function mirrorSettingsPatchToHost(
  patch: Partial<Omit<AppSettings, "id">>,
  deps: { enqueueJob?: typeof enqueue; isMirrored?: () => boolean } = {}
): Promise<string[]> {
  const isMirrored = deps.isMirrored ?? isMirroredSettingsClient
  if (!isMirrored()) return []

  const writable: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (WRITABLE.has(key)) writable[key] = value
  }
  const keys = Object.keys(writable)
  if (keys.length === 0) return []

  await (deps.enqueueJob ?? enqueue)({
    command: "app_settings_update",
    payload: { patch: writable },
    // Machine-readable on purpose. The old per-page enqueue called
    // `t("mobile.settingsPanel.queueLabel")`, whose message carries no
    // placeholder — every settings edit queued the same sentence ("Queued —
    // desktop will apply this when online."), which said nothing the queue
    // count did not already say. Writing this from the persistence funnel puts
    // it outside React, where resolving a locale would mean pulling the message
    // bundle into a Dexie write; and `MobileOutboundJobRow.label` has no
    // renderer today (the offline banner shows counts, not rows). So the row
    // carries the keys it will apply, which is what a queue UI would need to
    // translate. That key list is data, not a user-facing string — a UI that
    // renders it must localise around it, not print it raw.
    label: keys.join(", "),
  })
  return keys
}
