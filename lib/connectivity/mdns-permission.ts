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

import { detectNativePlatform } from "@/lib/capacitor/_shared"

export type MdnsPermissionOutcome =
  | { kind: "granted" }
  | { kind: "denied" }
  | { kind: "prompt" }
  | { kind: "unsupported" }

interface ZeroconfPermissionShape {
  requestPermissions?(): Promise<{ localNetwork: "granted" | "denied" | "prompt" }>
}

export type PermissionLoader = () => Promise<ZeroconfPermissionShape>

const defaultLoader: PermissionLoader = async () => {
  if (detectNativePlatform() !== "mobile") {
    throw new Error("mDNS permission check only available on mobile")
  }
  const moduleId = "capacitor-zeroconf"
  const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
    Zeroconf?: ZeroconfPermissionShape
  }
  if (!mod.Zeroconf) throw new Error("capacitor-zeroconf did not export Zeroconf")
  return mod.Zeroconf
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
  // Android builds of capacitor-zeroconf expose `requestPermissions` as a
  // no-op resolving to `{ localNetwork: "granted" }`; iOS 14+ shows the
  // system prompt the first time. Treat a missing method as granted.
  if (typeof plugin.requestPermissions !== "function") {
    return { kind: "granted" }
  }
  try {
    const result = await plugin.requestPermissions()
    return { kind: result.localNetwork }
  } catch {
    // The plugin throws if the system service is unavailable (rare). Treat
    // as `denied` so the UI shows the openSettings CTA.
    return { kind: "denied" }
  }
}
