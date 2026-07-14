/**
 * Renderer-facing client for the optional desktop "Pro IDE" mode
 * (`src-tauri/src/codeserver/`). Thin pass-throughs via the shared `transport`
 * so web/mobile shells reject cleanly instead of throwing. Two surfaces:
 *
 *  - process lifecycle (`codeserver_*`) — download/spawn/health of the
 *    code-server binary, one instance per project root;
 *  - native pane embedding (`codeserver_embed_*`) — a separate child webview
 *    from the in-app browser preview, so both can be shown at once.
 */
import type { ElementRect } from "@/lib/browser/protocol"
import { transport } from "@/lib/tauri"

/** Mirror of `codeserver::process::CodeServerStatus`. */
export interface CodeServerStatus {
  running: boolean
  port: number | null
  version: string
}

/** Mirror of `codeserver::download::InstallInfo`. */
export interface CodeServerInstallInfo {
  version: string
  installDir: string
  binaryPath: string
}

/** Payload of the `codeserver://download-progress` event. */
export interface CodeServerDownloadProgress {
  stage: "downloading" | "verifying" | "extracting" | "done"
  bytesDone: number
  bytesTotal: number
  message: string
}

export const CODESERVER_EVENTS = {
  downloadProgress: "codeserver://download-progress",
} as const

export const codeServerClient = {
  /** Whether this host has a prebuilt code-server binary (macOS/Linux). */
  supported: () => transport.call<boolean>("codeserver_supported", {}),
  /** Ensure a healthy code-server serves `root`; returns its loopback port. */
  ensure: (root: string) => transport.call<CodeServerStatus>("codeserver_ensure", { root }),
  /** Current status for `root` without spawning. */
  status: (root: string) => transport.call<CodeServerStatus>("codeserver_status", { root }),
  /** Stop the code-server serving `root`. Returns whether one was running. */
  stop: (root: string) => transport.call<boolean>("codeserver_stop", { root }),
  /** Stop every running code-server (global shutdown / kill switch). */
  stopAll: () => transport.call<void>("codeserver_stop_all", {}),
  /** Download + install code-server without spawning (pre-fetch). */
  download: () => transport.call<CodeServerInstallInfo>("codeserver_download", {}),

  /** Create or re-navigate the code-server pane webview at the reserved rect. */
  embedCreate: (url: string, rect: ElementRect) =>
    transport.call<string>("codeserver_embed_create", { url, ...rect }),
  embedSetBounds: (rect: ElementRect) =>
    transport.call<void>("codeserver_embed_set_bounds", { ...rect }),
  embedSetVisible: (visible: boolean, rect: ElementRect) =>
    transport.call<void>("codeserver_embed_set_visible", { visible, ...rect }),
  embedNavigate: (url: string) => transport.call<void>("codeserver_embed_navigate", { url }),
  embedDestroy: () => transport.call<void>("codeserver_embed_destroy", {}),
}

export type CodeServerClient = typeof codeServerClient
