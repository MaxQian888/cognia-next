/**
 * LSP registry — renderer-side orchestrator for the standalone-LSP
 * pathway (Phase B of the LSP reuse work, plan
 * `~/.claude/plans/vscode-lsp-mighty-robin.md`).
 *
 * Roles:
 *
 *   1. Track every running LSP server keyed by `${ownerId}:${serverId}`.
 *      `ownerId` is either a `pluginId` (when the server was contributed
 *      via `PluginManifest.lspServers`) or the literal `"user"` (when
 *      the user added it through Settings → Language Servers).
 *
 *   2. Drive the LSP-binary policy gate on every spawn — never let an
 *      unsigned binary run without going through
 *      `lib/plugin/vscode-shim/lsp-binary-policy.ts:evaluateLspBinary`.
 *
 *   3. Bridge `publishDiagnostics` notifications from the LSP into the
 *      `monaco-bridge.setDiagnostics` API so red squigglies actually
 *      appear in the Skills/Canvas/Artifact editors.
 *
 *   4. Register Monaco providers (completion, hover, ...) for every
 *      declared `language` so the editor proxies its provider calls into
 *      the LSP via the registered `CogniaLspClient`.
 *
 * The actual LSP client process runs in the Node sidecar; the registry
 * talks to it via an injectable adapter so unit tests stay
 * deterministic and don't need a real Tauri runtime. Production code
 * wires the adapter to the `vscode-ext-host` sidecar (see B3
 * integration).
 */

import { loggers } from "@cognia/logging"
import type { PluginLspServerDef } from "@/types/plugin"
import {
  evaluateLspBinary,
  type LspBinaryEvaluation,
} from "@/lib/plugin/vscode-shim/lsp-binary-policy"
import { lspPublishDiagnosticsToBridgePayload } from "@/lib/plugin/vscode-shim/lsp-protocol-adapter"
import {
  flushMaterializedDocument,
  resolveMaterializedDocumentUri,
  resolveMonacoDocumentUri,
  onWorkspaceFoldersChanged,
} from "@/lib/plugin/vscode-shim/lsp-workspace-manager"
import { registerLspMonacoProviders } from "./lsp-monaco-runtime"

const lspRegistryLogger = loggers.plugin.child("lsp-registry")

export type LspServerOwner = string // pluginId or "user"

export type LspServerState = "stopped" | "starting" | "running" | "crashed"

export interface LspServerRecord {
  ownerId: LspServerOwner
  serverId: string
  /** Composite key — `${ownerId}:${serverId}`. */
  key: string
  config: PluginLspServerDef
  /** Absolute install dir, for the lsp-binary-policy inside-check. */
  pluginPath: string
  state: LspServerState
  /** When state transitioned into "running". */
  startedAt?: number
  /** Last error encountered, if any (presented in Settings → Language Servers). */
  lastError?: string
  /** Reason the policy gate returned `requiresPrompt: true`, if applicable. */
  consentReason?: string
  /** Capabilities returned by the successful initialize handshake. */
  capabilities?: Record<string, unknown>
  /** Stable registration order used as the final server-priority tie-breaker. */
  registrationOrder: number
}

/**
 * Adapter the registry uses to actually spawn / stop LSP processes.
 * Production wires this to a Tauri command that talks to the sidecar;
 * tests inject a fake.
 */
export interface LspClientAdapter {
  /**
   * Start the LSP server. Resolves once `initialize` succeeds. The
   * adapter is responsible for forwarding `publishDiagnostics`
   * notifications back via `onDiagnostics`.
   */
  start(input: {
    ownerId: LspServerOwner
    serverId: string
    config: PluginLspServerDef
    workspaceFolders?: Array<{ uri: string; name: string }>
    onDiagnostics(
      uri: string,
      markers: ReturnType<typeof lspPublishDiagnosticsToBridgePayload>["markers"]
    ): void
    onServerRequest?(event: LspServerRequestEvent): void
    onServerNotification?(event: LspServerNotificationEvent): void
  }): Promise<{ capabilities?: unknown } | void>
  /** Stop a running server. Idempotent on a stopped/missing server. */
  stop(ownerId: LspServerOwner, serverId: string): Promise<void>
  didOpen?(input: {
    ownerId: string
    serverId: string
    uri: string
    languageId: string
    text: string
  }): Promise<void>
  didChange?(input: { ownerId: string; serverId: string; uri: string; text: string }): Promise<void>
  didClose?(input: { ownerId: string; serverId: string; uri: string }): Promise<void>
  request?(input: {
    ownerId: string
    serverId: string
    method: string
    payload: unknown
    requestId?: string
  }): Promise<unknown>
  clientNotification?(input: {
    ownerId: string
    serverId: string
    method: string
    payload: unknown
  }): Promise<boolean>
  onStateChange?(
    listener: (event: {
      ownerId: string
      serverId: string
      state: LspServerState | "broken"
      lastError?: string
    }) => void
  ): () => void
}

export interface LspServerRequestEvent {
  requestId: string
  method: string
  payload: unknown
  preconditions?: Record<string, { exists: boolean; version?: number; contentHash?: string }>
}

export interface LspServerNotificationEvent {
  method: string
  payload: unknown
}

/**
 * Bridge entry-points the registry uses to forward LSP outputs into the
 * existing Monaco infrastructure. Tests inject mocks; production wires
 * these to the actual `lib/plugin/vscode-shim/monaco-bridge.ts` exports.
 */
export interface LspBridgeAdapter {
  /** Push diagnostics for a document. */
  setDiagnostics(input: {
    extensionId: string
    uri: string
    markers: ReturnType<typeof lspPublishDiagnosticsToBridgePayload>["markers"]
  }): void
  onEditorChange?(
    listener: (event: {
      editorId: string
      uri: string
      kind: "open" | "close" | "change-selection" | "change-content"
    }) => void
  ): () => void
  getEditorById?(editorId: string):
    | {
        getModel(): { uri: string; language: string; getValue(): string } | null
      }
    | undefined
}

interface RegistryDeps {
  client: LspClientAdapter
  bridge: LspBridgeAdapter
  /**
   * Resolve workspace folders the LSP should see (typically the
   * synthetic per-surface workspaces from `lsp-workspace-manager`).
   * Returning an empty array is fine when no surface is active yet.
   */
  resolveWorkspaceFolders: () => Array<{ uri: string; name: string }>
  /** Override `Date.now` for deterministic tests. */
  now: () => number
}

let deps: RegistryDeps | null = null
const records = new Map<string, LspServerRecord>()
const providerDisposables = new Map<string, { dispose(): void }>()
const documentServers = new Map<string, { recordKey: string; fileUri: string }>()
let nextRegistrationOrder = 0
let unsubscribeEditorChanges: (() => void) | null = null
let unsubscribeServerState: (() => void) | null = null
let unsubscribeWorkspaceFolders: (() => void) | null = null
const documentQueues = new Map<string, Promise<void>>()

/**
 * Wire the registry. Called once at app init (or per-test). Returns a
 * dispose function that unregisters every running server.
 */
export function configureLspRegistry(input: RegistryDeps): () => void {
  deps = input
  unsubscribeEditorChanges =
    input.bridge.onEditorChange?.((event) => {
      if (event.kind === "change-selection") return
      const previous = documentQueues.get(event.uri) ?? Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(() => handleEditorChange(input, event))
        .finally(() => {
          if (documentQueues.get(event.uri) === next) documentQueues.delete(event.uri)
        })
      documentQueues.set(event.uri, next)
    }) ?? null
  unsubscribeServerState =
    input.client.onStateChange?.((event) => {
      const record = records.get(key(event.ownerId, event.serverId))
      if (!record) return
      record.state = event.state === "broken" ? "crashed" : event.state
      record.lastError = event.lastError
      reconcileProviderRegistrations(input.client)
    }) ?? null
  let previousFolders = input.resolveWorkspaceFolders()
  unsubscribeWorkspaceFolders = onWorkspaceFoldersChanged(() => {
    const nextFolders = input.resolveWorkspaceFolders()
    const before = new Map(previousFolders.map((folder) => [folder.uri, folder]))
    const after = new Map(nextFolders.map((folder) => [folder.uri, folder]))
    const added = nextFolders.filter((folder) => !before.has(folder.uri))
    const removed = previousFolders.filter((folder) => !after.has(folder.uri))
    previousFolders = nextFolders
    if (added.length === 0 && removed.length === 0) return
    void updateRunningServerWorkspaces(input, added, removed)
  })
  return async () => {
    unsubscribeEditorChanges?.()
    unsubscribeEditorChanges = null
    unsubscribeServerState?.()
    unsubscribeServerState = null
    unsubscribeWorkspaceFolders?.()
    unsubscribeWorkspaceFolders = null
    disposeAllProviders()
    const keys = [...records.keys()]
    for (const k of keys) {
      const rec = records.get(k)
      if (!rec) continue
      try {
        await input.client.stop(rec.ownerId, rec.serverId)
      } catch {
        /* swallow */
      }
      records.delete(k)
    }
    deps = null
    documentServers.clear()
    documentQueues.clear()
  }
}

/** Test-only: clear every record and unset the adapter. */
export function __resetLspRegistryForTesting(): void {
  unsubscribeEditorChanges?.()
  unsubscribeEditorChanges = null
  unsubscribeServerState?.()
  unsubscribeServerState = null
  unsubscribeWorkspaceFolders?.()
  unsubscribeWorkspaceFolders = null
  disposeAllProviders()
  records.clear()
  documentServers.clear()
  documentQueues.clear()
  nextRegistrationOrder = 0
  deps = null
}

function key(ownerId: LspServerOwner, serverId: string): string {
  return `${ownerId}:${serverId}`
}

function assertConfigured(): RegistryDeps {
  if (!deps) {
    throw new Error("lsp-registry: configureLspRegistry must be called before any operation")
  }
  return deps
}

/**
 * Register one LSP server. Runs the binary policy gate; if the policy
 * denies the spawn (no trusted publisher + no dev-mode override), the
 * record is stored with `state: "stopped"` and `consentReason` set —
 * the UI can surface this and offer a one-click consent flow that
 * re-calls `register` with `confirmedConsent: true`.
 */
export async function registerLspServer(input: {
  ownerId: LspServerOwner
  config: PluginLspServerDef
  pluginPath: string
  /** When true, skip the binary policy gate (called from the consent UI). */
  confirmedConsent?: boolean
}): Promise<LspServerRecord> {
  const d = assertConfigured()
  const k = key(input.ownerId, input.config.id)
  if (records.has(k)) {
    throw new Error(`lsp-registry: server ${k} is already registered`)
  }
  const record: LspServerRecord = {
    ownerId: input.ownerId,
    serverId: input.config.id,
    key: k,
    config: input.config,
    pluginPath: input.pluginPath,
    state: "stopped",
    registrationOrder: nextRegistrationOrder++,
  }
  records.set(k, record)

  // Policy gate — skipped only when the consent UI explicitly confirms.
  if (!input.confirmedConsent) {
    let policy: LspBinaryEvaluation
    try {
      policy = await evaluateLspBinary({
        pluginId: input.ownerId,
        binaryPath: resolveBinaryPath(input.config.command, input.pluginPath),
        pluginPath: input.pluginPath,
      })
    } catch (err) {
      record.lastError = err instanceof Error ? err.message : String(err)
      record.state = "crashed"
      lspRegistryLogger.warn("lsp-registry policy evaluation threw", {
        key: k,
        error: record.lastError,
      })
      return record
    }
    if (!policy.allowed) {
      record.consentReason = policy.reason
      lspRegistryLogger.info("lsp-registry server requires consent", {
        key: k,
        reason: policy.reason,
      })
      return record
    }
    if (policy.requiresPrompt) {
      // Allowed but needs prompt (dev-mode override path) — caller can
      // either skip prompting (treats as confirmed already) or surface
      // the reason. We treat allowed+prompt as "spawn now" and surface
      // the reason in the audit.
      record.consentReason = policy.reason
    }
  }

  // Spawn.
  record.state = "starting"
  try {
    const initialized = await d.client.start({
      ownerId: input.ownerId,
      serverId: input.config.id,
      config: input.config,
      workspaceFolders: d.resolveWorkspaceFolders(),
      onDiagnostics: (uri, markers) => {
        d.bridge.setDiagnostics({
          extensionId: k,
          uri: resolveMonacoDocumentUri(uri),
          markers,
        })
      },
    })
    record.capabilities =
      initialized && "capabilities" in initialized && initialized.capabilities
        ? (initialized.capabilities as Record<string, unknown>)
        : {}
    record.state = "running"
    record.startedAt = d.now()
    reconcileProviderRegistrations(d.client)
  } catch (err) {
    record.state = "crashed"
    record.lastError = err instanceof Error ? err.message : String(err)
    lspRegistryLogger.warn("lsp-registry server start failed", {
      key: k,
      error: record.lastError,
    })
    reconcileProviderRegistrations(d.client)
  }
  return record
}

/**
 * Unregister a single server. Idempotent.
 */
export async function unregisterLspServer(
  ownerId: LspServerOwner,
  serverId: string
): Promise<void> {
  const d = assertConfigured()
  const k = key(ownerId, serverId)
  const record = records.get(k)
  if (!record) return
  try {
    await d.client.stop(ownerId, serverId)
  } catch (err) {
    lspRegistryLogger.warn("lsp-registry stop failed", {
      key: k,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  providerDisposables.get(k)?.dispose()
  providerDisposables.delete(k)
  records.delete(k)
  reconcileProviderRegistrations(d.client)
}

/**
 * Unregister every server owned by an id — the plugin-manager calls
 * this on disable.
 */
export async function unregisterByOwner(ownerId: LspServerOwner): Promise<number> {
  const keys = [...records.keys()].filter((k) => k.startsWith(`${ownerId}:`))
  for (const k of keys) {
    const r = records.get(k)
    if (!r) continue
    await unregisterLspServer(r.ownerId, r.serverId)
  }
  return keys.length
}

/** Snapshot of every record. Useful for the Settings → Language Servers UI. */
export function listLspServers(): LspServerRecord[] {
  return [...records.values()]
}

/** Lookup the first record whose `languages` array includes `languageId`. */
export function getLspServerForLanguage(languageId: string): LspServerRecord | undefined {
  return [...records.values()]
    .filter((record) => record.state === "running" && record.config.languages.includes(languageId))
    .sort(compareServerPriority)[0]
}

/**
 * Convenience for plugin enable: register every entry under
 * `manifest.lspServers[]`. Aggregates errors so a single bad entry
 * doesn't abort the rest.
 */
export async function registerPluginLspServers(input: {
  pluginId: string
  pluginPath: string
  servers: PluginLspServerDef[]
}): Promise<LspServerRecord[]> {
  const out: LspServerRecord[] = []
  for (const cfg of input.servers) {
    try {
      const rec = await registerLspServer({
        ownerId: input.pluginId,
        config: cfg,
        pluginPath: input.pluginPath,
      })
      out.push(rec)
    } catch (err) {
      lspRegistryLogger.warn("registerPluginLspServers: entry failed", {
        pluginId: input.pluginId,
        serverId: cfg.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

function compareServerPriority(a: LspServerRecord, b: LspServerRecord): number {
  const ownerRank = (record: LspServerRecord) => (record.ownerId === "user" ? 0 : 1)
  return (
    ownerRank(a) - ownerRank(b) ||
    a.registrationOrder - b.registrationOrder ||
    a.serverId.localeCompare(b.serverId)
  )
}

function disposeAllProviders(): void {
  for (const disposable of providerDisposables.values()) disposable.dispose()
  providerDisposables.clear()
}

function reconcileProviderRegistrations(client: LspClientAdapter): void {
  disposeAllProviders()
  const activeLanguages = new Map<string, string[]>()
  const allLanguages = new Set([...records.values()].flatMap((record) => record.config.languages))
  for (const language of allLanguages) {
    const record = getLspServerForLanguage(language)
    if (!record) continue
    const selected = activeLanguages.get(record.key) ?? []
    selected.push(language)
    activeLanguages.set(record.key, selected)
  }
  for (const [recordKey, languages] of activeLanguages) {
    const record = records.get(recordKey)
    if (!record) continue
    try {
      providerDisposables.set(recordKey, registerLspMonacoProviders({ record, client, languages }))
    } catch (error) {
      lspRegistryLogger.warn("lsp-registry provider registration failed", {
        key: recordKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function supportsDynamicWorkspaceFolders(record: LspServerRecord): boolean {
  const workspace = record.capabilities?.workspace
  if (!workspace || typeof workspace !== "object") return false
  const folders = (workspace as Record<string, unknown>).workspaceFolders
  if (!folders || typeof folders !== "object") return false
  return Boolean((folders as Record<string, unknown>).changeNotifications)
}

async function updateRunningServerWorkspaces(
  input: RegistryDeps,
  added: Array<{ uri: string; name: string }>,
  removed: Array<{ uri: string; name: string }>
): Promise<void> {
  for (const record of [...records.values()].filter((item) => item.state === "running")) {
    if (supportsDynamicWorkspaceFolders(record) && input.client.clientNotification) {
      await input.client.clientNotification({
        ownerId: record.ownerId,
        serverId: record.serverId,
        method: "workspace/didChangeWorkspaceFolders",
        payload: { event: { added, removed } },
      })
      continue
    }
    await restartServerForWorkspaceChange(input, record)
  }
}

async function restartServerForWorkspaceChange(
  input: RegistryDeps,
  record: LspServerRecord
): Promise<void> {
  providerDisposables.get(record.key)?.dispose()
  providerDisposables.delete(record.key)
  record.state = "starting"
  try {
    await input.client.stop(record.ownerId, record.serverId)
    const initialized = await input.client.start({
      ownerId: record.ownerId,
      serverId: record.serverId,
      config: record.config,
      workspaceFolders: input.resolveWorkspaceFolders(),
      onDiagnostics: (uri, markers) =>
        input.bridge.setDiagnostics({
          extensionId: record.key,
          uri: resolveMonacoDocumentUri(uri),
          markers,
        }),
    })
    record.capabilities =
      initialized && typeof initialized === "object" && initialized.capabilities
        ? (initialized.capabilities as Record<string, unknown>)
        : {}
    record.state = "running"
    record.startedAt = input.now()
    record.lastError = undefined
  } catch (error) {
    record.state = "crashed"
    record.lastError = error instanceof Error ? error.message : String(error)
  }
  reconcileProviderRegistrations(input.client)
}

async function handleEditorChange(
  input: RegistryDeps,
  event: {
    editorId: string
    uri: string
    kind: "open" | "close" | "change-selection" | "change-content"
  }
): Promise<void> {
  const model = input.bridge.getEditorById?.(event.editorId)?.getModel()
  if (event.kind === "close") {
    const route = documentServers.get(event.uri)
    const record = route ? records.get(route.recordKey) : undefined
    const uri = route?.fileUri ?? resolveMaterializedDocumentUri(event.uri)
    if (record && uri && input.client.didClose) {
      await input.client.didClose({
        ownerId: record.ownerId,
        serverId: record.serverId,
        uri,
      })
    }
    documentServers.delete(event.uri)
    return
  }
  if (!model) return
  const record = getLspServerForLanguage(model.language)
  const uri = resolveMaterializedDocumentUri(event.uri)
  if (!record || !uri) return

  if (event.kind === "open") {
    documentServers.set(event.uri, { recordKey: record.key, fileUri: uri })
    await input.client.didOpen?.({
      ownerId: record.ownerId,
      serverId: record.serverId,
      uri,
      languageId: model.language,
      text: model.getValue(),
    })
    return
  }
  if (event.kind === "change-content") {
    const routedKey = documentServers.get(event.uri)?.recordKey
    const previous = routedKey ? records.get(routedKey) : undefined
    const routed = previous?.state === "running" ? previous : record
    if (!routed || !input.client.didChange) return
    const text = model.getValue()
    await flushMaterializedDocument(event.uri, text)
    if (routed.key !== routedKey) {
      documentServers.set(event.uri, { recordKey: routed.key, fileUri: uri })
      await input.client.didOpen?.({
        ownerId: routed.ownerId,
        serverId: routed.serverId,
        uri,
        languageId: model.language,
        text,
      })
      return
    }
    await input.client.didChange({
      ownerId: routed.ownerId,
      serverId: routed.serverId,
      uri,
      text,
    })
  }
}

/**
 * Resolve the binary path — relative paths anchor against the plugin
 * install directory; absolute paths flow through untouched.
 */
function resolveBinaryPath(command: string, pluginPath: string): string {
  // Strict absolute detection: covers POSIX `/x` and Windows `C:\x`.
  if (/^([a-zA-Z]:[\\/]|[/\\])/.test(command)) return command
  // Defensive normalisation so the inside-dir check stays consistent.
  const joined = `${pluginPath.replace(/[\\/]+$/g, "")}/${command.replace(/^[\\/]+/g, "")}`
  return joined
}

/**
 * Public export of the path resolver for tests that want to assert the
 * exact path the policy sees. Re-exporting keeps `resolveBinaryPath`
 * pure (no test-only flag needed).
 */
export const __testing = { resolveBinaryPath }

/** Public export so the user-managed settings UI can use the same composite key. */
export function lspServerKey(ownerId: LspServerOwner, serverId: string): string {
  return key(ownerId, serverId)
}
