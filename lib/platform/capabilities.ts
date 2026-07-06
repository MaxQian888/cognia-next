/**
 * Canonical, framework-free platform capability vocabulary (ADR 0060 — L0).
 *
 * A capability is a coarse, declarative answer to "can this runtime do X?"
 * that workflow nodes (and, later, placement/routing) can require without
 * branching on `isTauri()` ad hoc. This module is the SINGLE source of truth
 * for the vocabulary and for "what can the local runtime do" — device-to-hub
 * reporting (`device_capabilities_report`) and node requirements
 * (`NodeCatalogEntry.requires`) both speak these ids.
 *
 * Pure leaf: imports only `./detect`, no React and no `@/lib/tauri` /
 * `@/lib/capacitor`, so non-React `lib/` code and hooks can both depend on it
 * without circular imports — same discipline as `detect.ts`.
 */

import { detectPlatform, type Platform } from "./detect"

/**
 * Core capability ids. Extend deliberately — every id here is wire format
 * (persisted on `pairedDevices` rows and stamped into workflow node
 * `requires`), so ids are append-only and never renamed.
 *
 * - `shell`             — can spawn one-shot OS processes (git, scripts).
 * - `pty`               — has the integrated PTY-backed terminal.
 * - `sidecar`           — runs the Node sidecar (Claude host, builtin tools).
 * - `keyring`           — OS keyring access for `keyring:*` secret refs.
 * - `uia-automation`    — desktop UI automation (screenshot, click, UIA events).
 * - `ocr`               — native OCR pipeline.
 * - `camera` / `geolocation` / `barcode-scan` / `voice-record` / `share-sheet`
 *                       — Capacitor-native mobile facilities.
 * - `push-display`      — can surface push/local notifications to a human.
 * - `biometric`         — biometric prompt available.
 * - `webview`           — an interactive webview UI is attached.
 * - `headless`          — runs without an interactive UI (ADR 0059 cloud
 *                         brain; assigned to no webview platform here).
 * - `always-on`         — process hosts long-lived listeners that outlive the
 *                         page (Rust cron daemon, webhook receiver).
 * - `connector-runtime` — platform connector adapters run here.
 * - `mcp-runtime`       — MCP client/server stack runs here.
 */
export const CORE_CAPABILITY_IDS = [
  "shell",
  "pty",
  "sidecar",
  "keyring",
  "uia-automation",
  "ocr",
  "camera",
  "geolocation",
  "barcode-scan",
  "voice-record",
  "share-sheet",
  "push-display",
  "biometric",
  "webview",
  "headless",
  "always-on",
  "connector-runtime",
  "mcp-runtime",
] as const

export type CoreCapabilityId = (typeof CORE_CAPABILITY_IDS)[number]

/**
 * Full capability id space: core ids plus `plugin:<pluginId>` tags a plugin
 * may declare for its own nodes ("this node needs my plugin active here").
 */
export type CapabilityId = CoreCapabilityId | `plugin:${string}`

const CORE_ID_SET: ReadonlySet<string> = new Set(CORE_CAPABILITY_IDS)

/** True when `value` is a well-formed capability id (core or `plugin:<id>`). */
export function isCapabilityId(value: unknown): value is CapabilityId {
  if (typeof value !== "string") return false
  if (CORE_ID_SET.has(value)) return true
  return value.startsWith("plugin:") && value.length > "plugin:".length
}

/**
 * Static per-platform baselines. Deliberately conservative: a capability is
 * listed only when the shipped shell always provides it — finer-grained,
 * probed capabilities (e.g. camera permission actually granted) stay the
 * concern of the `lib/capacitor` outcome façade at call time.
 */
const PLATFORM_BASELINES: Record<Platform, readonly CapabilityId[]> = {
  tauri: Object.freeze([
    "webview",
    "shell",
    "pty",
    "sidecar",
    "keyring",
    "uia-automation",
    "ocr",
    "always-on",
    "connector-runtime",
    "mcp-runtime",
    "push-display",
  ] as const),
  mobile: Object.freeze([
    "webview",
    "camera",
    "geolocation",
    "barcode-scan",
    "voice-record",
    "share-sheet",
    "push-display",
    "biometric",
  ] as const),
  web: Object.freeze(["webview"] as const),
}

/**
 * Capabilities of the local runtime, derived from {@link detectPlatform}.
 * Frozen — callers must not mutate; memoize freely (the runtime never changes
 * after first paint).
 */
export function detectLocalCapabilities(): readonly CapabilityId[] {
  return PLATFORM_BASELINES[detectPlatform()]
}

/** True when `cap` is present in `caps` (defaults to the local baseline). */
export function hasCapability(
  cap: CapabilityId,
  caps: readonly CapabilityId[] = detectLocalCapabilities()
): boolean {
  return caps.includes(cap)
}

// ---------------------------------------------------------------------------
// Host profiles (ADR-0059 C3/F5)
// ---------------------------------------------------------------------------

/**
 * The deployment shape this client runs in. Orthogonal to
 * {@link detectPlatform}: `web` splits into a *cloud companion* (browser
 * paired to a headless cognia-server — execution happens server-side) and
 * *web standalone* (BYOK, in-webview only). Companion profiles pair the
 * local baseline with {@link serverBackedCapabilities}.
 */
export type HostProfile = "desktop" | "mobile-companion" | "cloud-companion" | "web-standalone"

/** Resolve the host profile. Stable after first paint; memoize freely. */
export function detectHostProfile(): HostProfile {
  const platform = detectPlatform()
  if (platform === "tauri") return "desktop"
  if (platform === "mobile") return "mobile-companion"
  // Lazy require keeps this module a pure leaf for non-web callers; the
  // web-companion module is itself a leaf over localStorage + env.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hasWebCompanionTarget } = require("./web-companion") as {
    hasWebCompanionTarget: () => boolean
  }
  return hasWebCompanionTarget() ? "cloud-companion" : "web-standalone"
}

/**
 * Capabilities the PAIRED SERVER executes on this profile's behalf (reached
 * over the companion RPC, not locally). Empty for hosts that are themselves
 * the execution plane (desktop) or have no server (web-standalone). UI
 * surfaces that proxy work — agents, source control, connectors — gate on
 * local-OR-server:
 *
 *   hasCapability(cap) || serverBackedCapabilities().includes(cap)
 */
export function serverBackedCapabilities(
  profile: HostProfile = detectHostProfile()
): readonly CapabilityId[] {
  switch (profile) {
    case "mobile-companion":
    case "cloud-companion":
      return SERVER_BACKED
    case "desktop":
    case "web-standalone":
      return EMPTY_CAPS
  }
}

const SERVER_BACKED: readonly CapabilityId[] = Object.freeze([
  "shell",
  "sidecar",
  "always-on",
  "connector-runtime",
  "mcp-runtime",
  "headless",
] as const)

const EMPTY_CAPS: readonly CapabilityId[] = Object.freeze([])
