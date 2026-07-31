"use client"

/**
 * iOS 14+ Local Network permission helper (Wave 4 / ADR-0026).
 *
 * Apple gates all Bonjour browsing behind a one-time Local Network prompt.
 * The user can deny — at which point our `MdnsScannerShape` returns silently
 * with zero results. There is **no programmatic API to re-prompt** once a
 * user has denied, so the UX has to fall back to deep-linking the user to
 * the iOS Settings → Privacy → Local Network screen.
 *
 * Android does not gate Bonjour discovery behind a runtime permission —
 * `kind: "granted"` is returned for the Android path so the UI can treat
 * the response uniformly.
 *
 * On web / Tauri the helper returns `kind: "unsupported"` so consumers can
 * hide the LAN-scan affordance entirely.
 */

import { makeDefaultLoader } from "@/lib/capacitor/_shared"

export type MdnsPermissionOutcome =
  { kind: "granted" } | { kind: "denied" } | { kind: "prompt" } | { kind: "unsupported" }

interface ZeroconfPermissionShape {
  requestPermissions?(): Promise<{ localNetwork: "granted" | "denied" | "prompt" }>
}

export type PermissionLoader = () => Promise<ZeroconfPermissionShape>

// Resolve through the shared loader: window.Capacitor.Plugins.ZeroConf first
// (registered at mobile boot from PluginHeaders — note the capital C; the
// package registers as "ZeroConf", not "Zeroconf"), then the dynamic import.
const defaultLoader: PermissionLoader = makeDefaultLoader<ZeroconfPermissionShape>(
  "capacitor-zeroconf",
  "ZeroConf"
)

/** Capacitor rejects unimplemented proxy methods with this code/message. */
function isUnimplemented(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === "UNIMPLEMENTED") return true
  const message = err instanceof Error ? err.message : String(err)
  return /not implemented/i.test(message)
}

export async function requestMdnsPermission(
  loader: PermissionLoader = defaultLoader
): Promise<MdnsPermissionOutcome> {
  let plugin: ZeroconfPermissionShape
  try {
    plugin = await loader()
  } catch {
    return { kind: "unsupported" }
  }
  // capacitor-zeroconf ships NO `requestPermissions` (its definitions.ts has
  // only watch/unwatch/register/etc). A test double may genuinely lack the
  // property, but the real Capacitor native proxy fabricates a callable for
  // ANY name — so feature-detection must be "call it and classify the
  // rejection", not `typeof`.
  if (typeof plugin.requestPermissions !== "function") {
    return { kind: "granted" }
  }
  try {
    const result = await plugin.requestPermissions()
    return { kind: result.localNetwork }
  } catch (err) {
    // UNIMPLEMENTED ⇒ the plugin simply has no permission API. Android needs
    // none for Bonjour; iOS shows its Local Network prompt implicitly on the
    // first browse. Report granted so the scan proceeds (a real iOS denial
    // just yields zero results — Apple exposes no query API for this).
    if (isUnimplemented(err)) return { kind: "granted" }
    // Anything else (system service unavailable, plugin crash) → denied so
    // the UI shows the openSettings CTA.
    return { kind: "denied" }
  }
}
