/**
 * The plugin contract's share of `lib/platform/capabilities.ts`, which re-exports these.
 */

export type CoreCapabilityId = (typeof CORE_CAPABILITY_IDS)[number]

/**
 * Full capability id space: core ids plus `plugin:<pluginId>` tags a plugin
 * may declare for its own nodes ("this node needs my plugin active here").
 */
export type CapabilityId = CoreCapabilityId | `plugin:${string}`

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
 * - `ocr`               — native/server OCR pipeline.
 * - `media`             — local/server FFmpeg media processing. Shipped by desktop
 *                         and headless hosts; missing FFmpeg/FFprobe dependencies
 *                         are reported when the operation runs.
 * - `camera` / `geolocation` / `barcode-scan` / `voice-record` / `share-sheet`
 *                       — Capacitor-native mobile facilities.
 * - `push-display`      — can surface push/local notifications to a human.
 * - `biometric`         — biometric prompt available.
 * - `webview`           — an interactive webview UI is attached.
 * - `browser`           — provides an Agent-operable browser engine; workspace
 *                         readiness is checked when an operation runs.
 * - `headless`          — runs without an interactive UI (ADR 0059 cloud
 *                         brain; assigned to no webview platform here).
 * - `always-on`         — process hosts long-lived listeners that outlive the
 *                         page (Rust cron daemon, webhook receiver).
 * - `connector-runtime` — platform connector adapters run here.
 * - `mcp-runtime`       — MCP client/server stack runs here.
 * - `pro-ide`           — can host the embedded code-server "Pro IDE"
 *                         (ADR-0088). Coarse like its neighbours: listed for
 *                         desktop and headless hosts, while `codeserver_supported()`
 *                         still answers the per-OS/arch question at call time.
 * - `sandbox-pool`      — the host can run the runtime-environment sandbox pool
 *                         (ADR-0182): the headless cognia-server, and the
 *                         desktop with remote sandbox providers (ADR-0221).
 *                         Coarse in the same way: whether the pool is ON (an
 *                         operator's switch on a server, a configured provider
 *                         and a pinned bundle on a desktop) is answered at
 *                         call time with `sandbox_pool_disabled`. The
 *                         desktop's LOCAL containers remain dormant.
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
  "media",
  "sandbox-pool",
] as const
