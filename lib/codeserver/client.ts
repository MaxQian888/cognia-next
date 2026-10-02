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
import { ensureRemoteIdeRelay, stopRemoteIdeRelay } from "@/lib/codeserver/remote-relay"
import { isTauri, transport } from "@/lib/tauri"
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
  /**
   * Whether agent drive is available in this workbench. Present only for a
   * running managed-profile instance; the workbench runs either way.
   */
  broker?: CodeServerBrokerStatus
}

/** Why a managed workbench is running without its broker. */
export type CodeServerBrokerDisabledReason =
  "admin-disabled" | "install-failed" | "registration-failed" | "protocol-incompatible"

/** Mirror of `codeserver::agent_channel::BrokerStatus`. */
export interface CodeServerBrokerStatus {
  enabled: boolean
  reason?: CodeServerBrokerDisabledReason
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

/**
 * One row in a companion-extension side-bar tree.
 *
 * Flat and pre-formatted on purpose: the extension renders what it is given and
 * decides nothing. Anything it would need business logic for — which issues are
 * open, what a plan's status means, how to order them — is the app's job, so a
 * rendering bug can never become a wrong answer about the user's work.
 */
export interface CodeServerWorkspaceRow {
  /** Stable id, used as the tree item id and echoed back on activation. */
  id: string
  label: string
  /** Secondary text shown dimmed after the label (status, assignee, …). */
  description?: string
  /** Codicon id (e.g. `issue-opened`), already resolved by the app. */
  icon?: string
  /**
   * Workspace-relative or absolute file this row points at, when it has one.
   * Clicking a row with a path opens it in place; rows without one fall back to
   * revealing the item in Cognia.
   */
  path?: string
  /** 1-based line to reveal alongside `path`. */
  line?: number
}

/** A titled group of rows — one tree in the Cognia view container. */
export interface CodeServerWorkspaceGroup {
  /** `issues` | `plans` | `runs` — matches the contributed view ids. */
  id: string
  /** Already-localized heading; the extension never translates app data. */
  title: string
  rows: CodeServerWorkspaceRow[]
  /** Shown in place of an empty tree. */
  emptyText?: string
}

/**
 * What the companion extension renders: a connection summary for the status bar
 * plus the grouped rows for its side-bar trees.
 */
export interface CodeServerWorkspaceSnapshot {
  /** Status-bar text, already localized (e.g. "Cognia: 3 open"). */
  statusText: string
  /** Status-bar tooltip, already localized. */
  statusTooltip?: string
  /**
   * Draws the user's eye when something needs it — mapped to VS Code's warning
   * background. Set by the app (e.g. new errors past the threshold), never
   * inferred by the extension.
   */
  attention?: boolean
  groups: CodeServerWorkspaceGroup[]
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
  name:
    | "activeEditorChanged"
    | "selectionChanged"
    | "documentSaved"
    | "diagnosticsChanged"
    | "chatContextRequested"
    /** "Send Problems to Cognia": payload is a {@link CodeServerDiagnosticsHandoff}. */
    | "diagnosticsHandoffRequested"
    /** A workspace-panel row was clicked: payload is a {@link CodeServerWorkspaceRow}. */
    | "workspaceRowActivated"
    /** The extension (re)connected; push it a fresh workspace snapshot. */
    | "bridgeConnected"
    /** A long editor verb reported progress: payload is a {@link CodeServerBrokerProgress}. */
    | "brokerProgress"
  payload: { path?: string | null; empty?: boolean; count?: number } | null
}

/** Payload of `diagnosticsHandoffRequested`: errors and warnings, 1-based. */
export interface CodeServerDiagnosticsHandoff {
  total: number
  files: Array<{
    path: string
    relativePath: string
    diagnostics: Array<{ message: string; severity: string; line: number; column: number }>
  }>
}

/** An editor verb that reports progress over the broker. */
export type CodeServerProgressOperation = "applyEdit" | "saveAll" | "managedProxyHandshake"

/** Payload of `brokerProgress`: one `$/progress` report for a host request. */
export interface CodeServerBrokerProgress {
  token: number | string
  value: {
    kind: "begin" | "report" | "end"
    operation: CodeServerProgressOperation
    percentage?: number
    done?: number
    total?: number
    path?: string
    pluginId?: string
  }
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

/**
 * A broker problem the IDE surfaces instead of failing silently. Mirrors
 * `BrokerIssue` in `crates/cognia-codeserver/src/agent_channel.rs`.
 *
 * - `protocol-incompatible`: the extension and host share no protocol major.
 * - `install-failed`: the bundled broker failed its integrity check or install.
 * - `registration-failed`: the broker's credential file could not be written.
 * - `credential-replayed`: the single-use credential was used by two parties,
 *   so the host closed every connection, revoked the session and issued a new one.
 *
 * The first three start the workbench without the broker (agent drive off).
 */
export type CodeServerBrokerIssue =
  "protocol-incompatible" | "install-failed" | "registration-failed" | "credential-replayed"

/** `codeserver://broker-issue`: a {@link CodeServerBrokerIssue} for `root`. */
export interface CodeServerBrokerIssueEvent {
  root: string
  issue: CodeServerBrokerIssue
}

export const CODESERVER_EVENTS = {
  downloadProgress: "codeserver://download-progress",
  instanceExited: "codeserver://instance-exited",
  editorEvent: "codeserver://editor-event",
  brokerRequest: "codeserver://broker-request",
  brokerNotification: "codeserver://broker-notification",
  brokerIssue: "codeserver://broker-issue",
  /** A paired device asks this desktop's owner to open a project's Pro IDE. */
  relayGrantRequested: "codeserver://relay-grant-requested",
  /** One recorded broker frame, while Managed IDE Dev Mode is on. */
  brokerTrace: "codeserver://broker-trace",
} as const

/**
 * Mirror of `cognia_codeserver::broker_trace::TraceEntry`: one frame the
 * agent channel exchanged with an editor, recorded only during Dev Mode.
 * `payload` is the payload's shape (keys, lengths, leaf types) unless the
 * session opted into values, which the panel redacts before showing.
 */
export interface CodeServerBrokerTraceEntry {
  seq: number
  atMs: number
  root: string
  generation: number
  direction: "outbound" | "inbound"
  kind: "request" | "response" | "notification" | "event"
  method: string | null
  id: string | null
  pluginId: string | null
  bytes: number
  durationMs: number | null
  errorCode: number | null
  payload: unknown
}

/** Mirror of `cognia_codeserver::broker_trace::TraceMode`. */
export interface CodeServerBrokerTraceMode {
  enabled: boolean
  includePayloads: boolean
}

/** Mirror of `codeserver::relay_grants::PendingRelayGrant`. */
export interface CodeServerRelayGrantRequest {
  id: string
  deviceId: string
  /** Canonical project root on this desktop. */
  root: string
  requestedAtMs: number
}

/** Mirror of `codeserver::relay_grants::RelayGrant`. */
export interface CodeServerRelayGrant {
  deviceId: string
  root: string
  grantedAtMs: number
}

let remoteLifecycleRevision = 0

async function stopInstance<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const hadRemote = isTauri() && getActiveRemoteEndpoint() != null
  if (hadRemote) remoteLifecycleRevision += 1
  const remoteStop = transport.call<T>(command, args)
  // Queue local teardown immediately, before awaiting an unreachable host.
  // A later ensure is then ordered after this stop, rather than being torn
  // down when an older host's slow stop eventually finishes.
  const [hostResult, relayResult] = await Promise.allSettled([
    remoteStop,
    hadRemote ? stopRemoteIdeRelay() : Promise.resolve(),
  ])
  if (hostResult.status === "rejected") throw hostResult.reason
  if (relayResult.status === "rejected") throw relayResult.reason
  return hostResult.value
}

export const codeServerClient = {
  /** Whether this host has a prebuilt code-server binary (macOS/Linux). */
  supported: () => transport.call<boolean>("codeserver_supported", {}),
  /** Ensure a healthy code-server serves `root`; returns its loopback port. */
  ensure: async (root: string, profile: CodeServerProfile = "managed") => {
    const endpoint = isTauri() ? getActiveRemoteEndpoint() : null
    const revision = remoteLifecycleRevision
    const status = await transport.call<CodeServerStatus>("codeserver_ensure", { root, profile })
    if (
      isTauri() &&
      (endpoint !== getActiveRemoteEndpoint() || revision !== remoteLifecycleRevision)
    ) {
      throw new Error("CODESERVER_OPEN_SUPERSEDED")
    }
    if (!endpoint) return status
    if (!status.relayPath) {
      // A host this old serves the workbench to no paired device at all.
      throw new Error(
        "CODESERVER_UPGRADE_REQUIRED: the host did not provide a managed IDE relay path"
      )
    }
    // A remote instance answers on a loopback port on the HOST, which `status`
    // reports as null because it means nothing here. What the pane can navigate
    // to is the desktop's own pinned relay in front of it, so the port it gets
    // back is the relay's — see `lib/codeserver/remote-relay.ts` for why that
    // also needs a credential refresh behind it.
    const relay = await ensureRemoteIdeRelay(endpoint, status.relayPath)
    return { ...status, port: relay.port }
  },
  /** Current status for `root` without spawning. */
  status: (root: string) => transport.call<CodeServerStatus>("codeserver_status", { root }),
  /**
   * Stop the code-server serving `root`. Returns whether one was running.
   *
   * The remote check is snapshotted BEFORE the first await, not read after it:
   * a caller that is detaching from a host issues the stop and then clears the
   * routing plane synchronously, so re-reading the endpoint afterwards would
   * report "local" and skip the relay teardown for the host being left.
   */
  stop: (root: string) => stopInstance<boolean>("codeserver_stop", { root }),
  /**
   * Stop every running code-server on the host this call routes to, and drop
   * the desktop relay if one is up.
   *
   * `codeserver_stop_all` is not a local-only command, so under an active
   * remote host this reaches THAT host — which is the point: nothing else ever
   * will. `list_managed_processes` is local-only, so a remote host's IDE
   * children never appear in Managed Processes, and `RemoteCodeServerState` has
   * no idle reaper. Detaching without this leaves them running for the life of
   * the remote process. Same pre-await snapshot as {@link stop}.
   */
  stopAll: () => stopInstance<void>("codeserver_stop_all", {}),
  /** Download + install code-server without spawning (pre-fetch). */
  download: () => transport.call<CodeServerInstallInfo>("codeserver_download", {}),
  /**
   * Paired devices waiting for this desktop's owner to let them into a
   * project's Pro IDE. The four relay-grant calls are desktop-local by
   * contract: a paired device can never answer its own request.
   */
  relayGrantPending: () =>
    transport.call<CodeServerRelayGrantRequest[]>("codeserver_relay_grant_pending", {}),
  /** Approve or deny one request; approving lasts until revoked. */
  relayGrantRespond: (id: string, approve: boolean) =>
    transport.call<CodeServerRelayGrant | null>("codeserver_relay_grant_respond", {
      id,
      approve,
    }),
  /** Every standing approval. */
  relayGrants: () => transport.call<CodeServerRelayGrant[]>("codeserver_relay_grants", {}),
  /** Withdraw one approval; that device's open session closes within seconds. */
  relayGrantRevoke: (deviceId: string, root: string) =>
    transport.call<boolean>("codeserver_relay_grant_revoke", { deviceId, root }),
  /**
   * Managed IDE Dev Mode: frames recorded after `since`, optionally for one
   * project. Empty unless Dev Mode is on. Desktop-local, like Dev Mode.
   */
  brokerTrace: (since?: number, root?: string) =>
    transport.call<CodeServerBrokerTraceEntry[]>("codeserver_broker_trace", {
      since: since ?? null,
      root: root ?? null,
    }),
  /** Keep payload values in the trace instead of shapes. Refused outside Dev Mode. */
  configureBrokerTrace: (includePayloads: boolean) =>
    transport.call<CodeServerBrokerTraceMode>("codeserver_broker_trace_configure", {
      includePayloads,
    }),
  /**
   * Managed IDE Dev Mode: activate a rebuilt proxy live without committing it.
   * The committed proxy comes back when Dev Mode ends. Refused outside Dev Mode.
   */
  activateProxyTemporary: (artifact: CodeServerProxyArtifact) =>
    transport.call<boolean>("codeserver_activate_proxy_temporary", { artifact }),
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
  /**
   * Push the workspace snapshot the companion extension renders in its status
   * bar item and side-bar trees.
   *
   * Whole snapshot, not a delta: the panel is small, the extension holds no
   * business logic of its own, and a dropped delta would leave a silently wrong
   * tree that nothing would ever correct.
   */
  pushWorkspaceSnapshot: (root: string, snapshot: CodeServerWorkspaceSnapshot) =>
    transport.call<void>("codeserver_agent_workspace_snapshot", { root, snapshot }),
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
