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
import type { ActiveEditorContext, ActiveEditorDiagnostic } from "@/lib/files/project-editor-bridge"
import { transport } from "@/lib/tauri"

/** Mirror of `codeserver::process::CodeServerStatus`. */
export interface CodeServerStatus {
  running: boolean
  port: number | null
  version: string
}

/** Mirror of `codeserver::download::CodeServerDiskUsage`. */
export interface CodeServerDiskUsage {
  version: string
  root: string
  installed: boolean
  totalBytes: number
  /** Bytes held by non-pinned installs + abandoned partial downloads. */
  reclaimableBytes: number
  staleVersions: string[]
}

/** Mirror of `codeserver::download::InstallInfo`. */
export interface CodeServerInstallInfo {
  version: string
  installDir: string
  binaryPath: string
}

/**
 * Live active-editor context read back from code-server (Pro IDE Phase 2).
 *
 * Aliases — not re-declares — the canonical engine-agnostic shape, because
 * Monaco now answers the same read. Two structurally-identical declarations
 * would drift the first time a field is added on one side only, and every
 * consumer downstream (the PII gate, the agent tool contract, the plugin API)
 * is written to be engine-blind.
 */
export type CodeServerDiagnostic = ActiveEditorDiagnostic
export type CodeServerActiveEditor = ActiveEditorContext

/** Payload of the `codeserver://download-progress` event. */
export interface CodeServerDownloadProgress {
  /**
   * `cancelled` is terminal like `done`, but reached because the user backed
   * out — the partial archive has already been removed. Surfaces separately so
   * the UI can go quiet instead of showing a retryable error.
   */
  stage: "downloading" | "verifying" | "extracting" | "done" | "cancelled"
  bytesDone: number
  bytesTotal: number
  message: string
}

/**
 * Payload of the `codeserver://instance-exited` event, emitted when the health
 * watchdog finds a previously-healthy instance has stopped answering. Match on
 * `port` — it is the value the pane actually navigated to, whereas `root` is
 * the backend's canonicalized spelling.
 */
export interface CodeServerExited {
  root: string
  port: number
}

export const CODESERVER_EVENTS = {
  downloadProgress: "codeserver://download-progress",
  instanceExited: "codeserver://instance-exited",
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
  /**
   * Abort an in-flight first-run download (~100-200MB). Safe to call when none
   * is running; the in-flight `ensure`/`download` call rejects and the partial
   * archive is removed backend-side.
   */
  cancelDownload: () => transport.call<void>("codeserver_cancel_download", {}),
  /** Pinned version, install state and disk footprint. */
  diskUsage: () => transport.call<CodeServerDiskUsage>("codeserver_disk_usage", {}),
  /**
   * Reclaim disk. `everything: false` drops only non-pinned installs and
   * partial downloads; `true` removes the install and the user data too.
   * Stops every running instance first. Returns the bytes freed.
   */
  uninstall: (everything: boolean) =>
    transport.call<number>("codeserver_uninstall", { everything }),
  /** Open a project-relative file in the running CodeServer window. */
  openFile: (root: string, path: string, line?: number, column?: number) =>
    transport.call<void>("codeserver_open_file", { root, path, line, column }),
  /**
   * Ask the companion extension (Pro IDE Phase 2) to open + reveal an ABSOLUTE
   * path in the live VS Code. Preferred over `openFile` (no CLI cold start);
   * rejects when the extension isn't connected, so callers fall back to it.
   */
  driveOpen: (root: string, path: string, line?: number, column?: number) =>
    transport.call<void>("codeserver_agent_open", { root, path, line, column }),
  /**
   * Ask the companion extension to reflect an agent's on-disk write to an
   * ABSOLUTE path as an undo-able edit in the live editor (a live diff instead of
   * a bare external reload). Rejects when the extension isn't connected.
   */
  driveApplyEdit: (root: string, path: string, line?: number, column?: number) =>
    transport.call<void>("codeserver_agent_apply_edit", { root, path, line, column }),
  /**
   * Read the live active-editor context (focused file, selection, selected text,
   * that file's diagnostics, open editors) back from code-server. Rejects when
   * the companion extension isn't connected. The caller PII-gates the payload
   * before it reaches the model.
   */
  readActive: (root: string) =>
    transport.call<CodeServerActiveEditor>("codeserver_agent_read_active", { root }),

  /** Raw `settings.json` for the embedded editor; `""` when it doesn't exist. */
  readUserSettings: () => transport.call<string>("codeserver_read_user_settings", {}),
  /**
   * Replace `settings.json`. VS Code hot-watches it, so this repaints a running
   * workbench without a reload.
   */
  writeUserSettings: (contents: string) =>
    transport.call<void>("codeserver_write_user_settings", { contents }),

  /**
   * Whether a local VS Code launcher (`code`) is on PATH. Backs the fallback
   * offered where the embedded Pro IDE has no build (Windows / exotic arch).
   */
  localVsCodeAvailable: () => transport.call<boolean>("codeserver_local_vscode_available", {}),
  /** Open an absolute path (project root or file) in the user's own VS Code. */
  openInLocalVsCode: (path: string, line?: number, column?: number) =>
    transport.call<void>("codeserver_open_in_local_vscode", { path, line, column }),

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
