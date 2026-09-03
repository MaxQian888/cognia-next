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
 * - `browser`           — an Agent-operable browser engine is ready.
 * - `headless`          — runs without an interactive UI (ADR 0059 cloud
 *                         brain; assigned to no webview platform here).
 * - `always-on`         — process hosts long-lived listeners that outlive the
 *                         page (Rust cron daemon, webhook receiver).
 * - `connector-runtime` — platform connector adapters run here.
 * - `mcp-runtime`       — MCP client/server stack runs here.
 * - `pro-ide`           — can host the embedded code-server "Pro IDE"
 *                         (ADR-0088). Coarse like its neighbours: listed for
 *                         the desktop shell, while `codeserver_supported()`
 *                         still answers the per-OS/arch question at call time.
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
  "browser",
  "headless",
  "always-on",
  "connector-runtime",
  "mcp-runtime",
  "pro-ide",
  "thread-handoff-v1",
] as const

export type CoreCapabilityId = (typeof CORE_CAPABILITY_IDS)[number]

/**
 * Full capability id space: core ids plus `plugin:<pluginId>` tags a plugin
 * may declare for its own nodes ("this node needs my plugin active here").
 */
export type CapabilityId = CoreCapabilityId | `plugin:${string}`

const CORE_ID_SET: ReadonlySet<string> = new Set(CORE_CAPABILITY_IDS)

/** Capabilities implemented by the cognia-server + brain execution plane. */
const SERVER_BACKED: readonly CapabilityId[] = Object.freeze([
  "shell",
  "pty",
  "sidecar",
  "keyring",
  "always-on",
  "connector-runtime",
  "mcp-runtime",
  "headless",
  "thread-handoff-v1",
] as const)

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
    "browser",
    "pro-ide",
    "thread-handoff-v1",
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
    "thread-handoff-v1",
  ] as const),
  web: Object.freeze(["webview"] as const),
  headless: SERVER_BACKED,
}

/** Immutable baseline for an explicitly selected execution platform. */
export function capabilitiesForPlatform(platform: Platform): readonly CapabilityId[] {
  return PLATFORM_BASELINES[platform]
}

/**
 * Capabilities of the local runtime, derived from {@link detectPlatform}.
 * Frozen — callers must not mutate; memoize freely (the runtime never changes
 * after first paint).
 */
export function detectLocalCapabilities(): readonly CapabilityId[] {
  return capabilitiesForPlatform(detectPlatform())
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
export type HostProfile =
  "desktop" | "mobile-companion" | "cloud-companion" | "web-standalone" | "headless"

/** Resolve the host profile. Stable after first paint; memoize freely. */
export function detectHostProfile(): HostProfile {
  const platform = detectPlatform()
  if (platform === "headless") return "headless"
  if (platform === "tauri") return "desktop"
  if (platform === "mobile") return "mobile-companion"
  // Lazy require keeps this module a pure leaf for non-web callers; the
  // web-companion module is itself a leaf over localStorage + env.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hasWebCompanionTarget } = require("./web-companion") as {
    hasWebCompanionTarget: () => boolean
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hasPairedRemoteHost } = require("./remote-host-pairing") as {
    hasPairedRemoteHost: () => boolean
  }
  // Both registries count. `hasWebCompanionTarget` only sees the credential
  // book (the `/pair` flow), while Settings > Remote hosts files its pairings
  // in the remote-host store instead. Reading one of the two made a browser
  // paired through the other look like it had no host at all, the narrowest
  // thing this profile can say, and the one the whole capability-keyed half of
  // Settings refuses on.
  return hasWebCompanionTarget() || hasPairedRemoteHost() ? "cloud-companion" : "web-standalone"
}

/**
 * Is there a host to run host-owned work on: this shell itself, or one it is
 * paired to?
 *
 * The single predicate behind six hand-rolled copies of
 * `isTauri() || isCapacitor() || hasWebCompanionTarget()` that used to live in
 * `lib/git/commands.ts`, `lib/subscription/core/migration.ts`,
 * `lib/logging/bootstrap.ts` (three of them) and
 * `components/devices/device-console.tsx`. All six shared one bug: the
 * headless brain has no `window.__TAURI_INTERNALS__`, no Capacitor and no
 * pairing of its own, so every copy classified the process that IS the
 * execution plane as a standalone browser.
 *
 * Phrased against the profile so the answer stays right as profiles are added:
 * exactly one of them, `web-standalone`, means "no host anywhere".
 */
export function hasHostRuntime(profile: HostProfile = detectHostProfile()): boolean {
  return profile !== "web-standalone"
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
    case "headless":
      return EMPTY_CAPS
  }
}

const EMPTY_CAPS: readonly CapabilityId[] = Object.freeze([])
