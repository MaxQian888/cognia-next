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
import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"

/** Mirror of `codeserver::process::CodeServerStatus`. */
export type CodeServerProfile = "managed" | "native"

export interface CodeServerStatus {
  running: boolean
  port: number | null
  version: string
  /** Absent only when talking to a pre-platform host during rolling upgrade. */
  profile?: CodeServerProfile | null
  /** Remote companion path. Never contains a credential or the host loopback port. */
  relayPath?: string | null
}

interface DesktopRelayStatus {
  port: number
  url: string
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

export interface CodeServerProxyAsset {
  sourcePath: string
  packagePath: string
  sha256?: string
}

export interface CodeServerProxyBuildRequest {
  pluginId: string
  pluginVersion: string
  pluginRoot: string
  manifestHash: string
  catalogHash: string
  contributions: unknown
  providers: unknown[]
  executables: unknown[]
  protocols: unknown
  assets: CodeServerProxyAsset[]
}

export interface CodeServerProxyArtifact {
  pluginId: string
  pluginVersion: string
  manifestHash: string
  catalogHash: string
  platformVersion: string
  sha256: string
  signature: string
  publicKey: string
  vsixPath: string
  executables: Array<{ id: string; sha256: string; path: string }>
}

export interface CodeServerContentHandle {
  $type: "ContentHandle"
  id: string
  size: number
  sha256: string
  mediaType: string
  expiresAtMs: number
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

/**
 * Outcome of a `saveAll`. A partial flush is still progress, so this reports both
 * halves rather than throwing: the caller needs to know *which* files it cannot
 * trust the on-disk copy of.
 */
export interface CodeServerSaveResult {
  saved: string[]
  failed: string[]
}

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

/**
 * Editor-state change pushed by the companion extension (`codeserver://editor-event`).
 *
 * The reverse direction of the agent channel: before this the renderer could only
 * *ask* (`readActive`), so "what is the user looking at" had to be polled. `payload`
 * is intentionally loose and advisory — every consumer re-reads the authoritative
 * snapshot through the editor bridge rather than trusting the event body.
 */
export interface CodeServerEditorEvent {
  /** Canonical project root of the reporting instance. */
  root: string
  name: "activeEditorChanged" | "selectionChanged" | "documentSaved" | "diagnosticsChanged"
  payload: { path?: string | null; empty?: boolean; count?: number } | null
}

export interface CodeServerBrokerRequest {
  root: string
  generation: number
  id: string | number
  method: string
  params: unknown
}

export interface CodeServerBrokerNotification {
  root: string
  generation: number
  method: string
  params: unknown
}

export const CODESERVER_EVENTS = {
  downloadProgress: "codeserver://download-progress",
  instanceExited: "codeserver://instance-exited",
  editorEvent: "codeserver://editor-event",
  brokerRequest: "codeserver://broker-request",
  brokerNotification: "codeserver://broker-notification",
} as const

export const codeServerClient = {
  /** Whether this host has a prebuilt code-server binary (macOS/Linux). */
  supported: () => transport.call<boolean>("codeserver_supported", {}),
  /** Ensure a healthy code-server serves `root`; returns its loopback port. */
  ensure: async (root: string, profile: CodeServerProfile = "managed") => {
    const status = await transport.call<CodeServerStatus>("codeserver_ensure", { root, profile })
    const endpoint = getActiveRemoteEndpoint()
    if (!endpoint) return status
    if (!status.relayPath) {
      throw new Error("remote host did not provide a managed IDE relay path")
    }
    if (!endpoint.serverFingerprint) {
      throw new Error("remote host is missing its paired certificate fingerprint")
    }
    const relay = await transport.call<DesktopRelayStatus>("codeserver_remote_relay_ensure", {
      baseUrl: endpoint.baseUrl,
      deviceJwt: endpoint.deviceJwt,
      serverFingerprint: endpoint.serverFingerprint,
      relayPath: status.relayPath,
    })
    return { ...status, port: relay.port }
  },
  /** Current status for `root` without spawning. */
  status: (root: string) => transport.call<CodeServerStatus>("codeserver_status", { root }),
  /** Stop the code-server serving `root`. Returns whether one was running. */
  stop: async (root: string) => {
    const stopped = await transport.call<boolean>("codeserver_stop", { root })
    if (getActiveRemoteEndpoint()) {
      await transport.call<boolean>("codeserver_remote_relay_stop", {})
    }
    return stopped
  },
  /** Stop every running code-server (global shutdown / kill switch). */
  stopAll: async () => {
    await transport.call<void>("codeserver_stop_all", {})
    if (getActiveRemoteEndpoint()) {
      await transport.call<boolean>("codeserver_remote_relay_stop", {})
    }
  },
  /** Download + install code-server without spawning (pre-fetch). */
  download: () => transport.call<CodeServerInstallInfo>("codeserver_download", {}),
  /** Generate and locally sign a managed proxy from normalized manifest IR. */
  buildProxy: (request: CodeServerProxyBuildRequest) =>
    transport.call<CodeServerProxyArtifact>("codeserver_build_proxy", { request }),
  /**
   * Promote a previously built and verified proxy into every live managed
   * profile. The host owns the activation handshake and restores the prior
   * proxy if live activation cannot complete.
   */
  activateProxy: (artifact: CodeServerProxyArtifact) =>
    transport.call<boolean>("codeserver_activate_proxy", { artifact }),
  /** List hash/signature-verified managed proxy artifacts. */
  listProxies: () => transport.call<CodeServerProxyArtifact[]>("codeserver_list_proxies", {}),
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
  /**
   * Flush dirty editor buffers to disk (all of them, or just `path`).
   *
   * Not a convenience: the agent's file tools read the filesystem, so an unsaved
   * buffer is invisible to them — a turn would reason about stale content and then
   * overwrite the user's unsaved work. Returns which files could and could not be
   * made trustworthy.
   */
  saveAll: (root: string, path?: string) =>
    transport.call<CodeServerSaveResult>("codeserver_agent_save_all", { root, path }),
  /**
   * Show `content` beside the on-disk `path` in VS Code's native diff editor, for
   * review before a change lands. The proposal is served from memory, never disk.
   */
  showDiff: (root: string, path: string, content: string, title?: string) =>
    transport.call<void>("codeserver_agent_show_diff", { root, path, content, title }),
  /** Reveal an absolute path in the editor's file explorer. */
  reveal: (root: string, path: string) =>
    transport.call<void>("codeserver_agent_reveal", { root, path }),
  /**
   * Run a command in the editor's integrated terminal. Show-the-user only — the
   * extension host cannot read terminal output back.
   */
  runInTerminal: (root: string, command: string, options?: { cwd?: string; name?: string }) =>
    transport.call<void>("codeserver_agent_run_in_terminal", {
      root,
      command,
      cwd: options?.cwd,
      name: options?.name,
    }),
  /** Surface an app-side message inside the editor. */
  notify: (root: string, message: string, kind?: "info" | "warning" | "error") =>
    transport.call<void>("codeserver_agent_notify", { root, message, kind }),
  respondToBroker: (
    request: Pick<CodeServerBrokerRequest, "root" | "generation" | "id">,
    outcome: { result?: unknown; error?: { code: number; message: string; data?: unknown } }
  ) =>
    transport.call<void>("codeserver_broker_respond", {
      ...request,
      result: outcome.result,
      error: outcome.error,
    }),
  notifyBroker: (
    root: string,
    generation: number,
    params: {
      pluginId: string
      providerId: string
      invocationId?: string
      event: string
      payload?: unknown
    }
  ) =>
    transport.call<void>("codeserver_broker_notify", {
      root,
      generation,
      params,
    }),
  validateBrokerPaths: (root: string, paths: string[]) =>
    transport.call<string[]>("codeserver_broker_validate_paths", {
      root,
      paths,
    }),
  createBrokerContent: (
    root: string,
    generation: number,
    pluginId: string,
    providerId: string,
    permission: string | null,
    mediaType: string,
    bytes: number[]
  ) =>
    transport.call<CodeServerContentHandle>("codeserver_broker_content_create", {
      root,
      generation,
      pluginId,
      providerId,
      permission,
      mediaType,
      bytes,
    }),
  redeemBrokerContent: (
    root: string,
    generation: number,
    pluginId: string,
    providerId: string,
    permission: string | null,
    handleId: string
  ) =>
    transport.call<number[]>("codeserver_broker_content_redeem", {
      root,
      generation,
      pluginId,
      providerId,
      permission,
      handleId,
    }),

  /** Raw `settings.json` for the embedded editor; `""` when it doesn't exist. */
  readUserSettings: (profile: CodeServerProfile = "managed") =>
    transport.call<string>("codeserver_read_user_settings", { profile }),
  /**
   * Replace `settings.json`. VS Code hot-watches it, so this repaints a running
   * workbench without a reload.
   */
  writeUserSettings: (contents: string, profile: CodeServerProfile = "managed") =>
    transport.call<void>("codeserver_write_user_settings", { contents, profile }),

  /**
   * Raw `argv.json` for the embedded editor — VS Code's *runtime* arguments,
   * where the display language lives. `""` when it doesn't exist.
   */
  readRuntimeArgs: (profile: CodeServerProfile = "managed") =>
    transport.call<string>("codeserver_read_runtime_args", { profile }),
  /**
   * Replace `argv.json`. Unlike `settings.json` this is read only at workbench
   * startup, so a locale change needs the instance restarted to take effect.
   */
  writeRuntimeArgs: (contents: string, profile: CodeServerProfile = "managed") =>
    transport.call<void>("codeserver_write_runtime_args", { contents, profile }),
  /**
   * Whether a VS Code display-language pack is published for `locale`. Lets the
   * UI say the editor has no translation instead of silently staying English.
   */
  languagePackAvailable: (locale: string) =>
    transport.call<boolean>("codeserver_language_pack_available", { locale }),

  /**
   * Whether a local VS Code launcher (`code`) is on PATH. Backs the fallback
   * offered where the embedded Pro IDE has no build (Windows / exotic arch).
   */
  localVsCodeAvailable: () => transport.call<boolean>("codeserver_local_vscode_available", {}),
  /** Open an absolute path (project root or file) in the user's own VS Code. */
  openInLocalVsCode: (path: string, line?: number, column?: number) =>
    transport.call<void>("codeserver_open_in_local_vscode", { path, line, column }),

  /**
   * Create or re-navigate the code-server pane webview at the reserved rect.
   *
   * `background` is the app's resolved background as `#RRGGBB`. A native webview
   * paints its own background before the loading page has one, and the platform
   * default is white — passing the app colour is what stops the pane flashing a
   * white rectangle over a dark app on every spawn and navigate.
   */
  embedCreate: (url: string, rect: ElementRect, background?: string) =>
    transport.call<string>("codeserver_embed_create", { url, ...rect, background }),
  /** Repaint the pane webview's own background (theme flip, no navigation). */
  embedSetBackground: (hex: string) =>
    transport.call<void>("codeserver_embed_set_background", { hex }),
  embedSetBounds: (rect: ElementRect) =>
    transport.call<void>("codeserver_embed_set_bounds", { ...rect }),
  embedSetVisible: (visible: boolean, rect: ElementRect) =>
    transport.call<void>("codeserver_embed_set_visible", { visible, ...rect }),
  embedNavigate: (url: string) => transport.call<void>("codeserver_embed_navigate", { url }),
  embedDestroy: () => transport.call<void>("codeserver_embed_destroy", {}),
}

export type CodeServerClient = typeof codeServerClient
