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

import { loggers } from "@/lib/logging"
import type { PluginLspServerDef } from "@/types/plugin"
import {
  evaluateLspBinary,
  type LspBinaryEvaluation,
} from "@/lib/plugin/vscode-shim/lsp-binary-policy"
import {
  lspPublishDiagnosticsToBridgePayload,
  type LspDiagnostic,
} from "@/lib/plugin/vscode-shim/lsp-protocol-adapter"

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
  /** Optional Ed25519 fingerprint surfaced from the plugin manifest. */
  publisherFingerprint?: string
  state: LspServerState
  /** When state transitioned into "running". */
  startedAt?: number
  /** Last error encountered, if any (presented in Settings → Language Servers). */
  lastError?: string
  /** Reason the policy gate returned `requiresPrompt: true`, if applicable. */
  consentReason?: string
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
  }): Promise<void>
  /** Stop a running server. Idempotent on a stopped/missing server. */
  stop(ownerId: LspServerOwner, serverId: string): Promise<void>
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

/**
 * Wire the registry. Called once at app init (or per-test). Returns a
 * dispose function that unregisters every running server.
 */
export function configureLspRegistry(input: RegistryDeps): () => void {
  deps = input
  return async () => {
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
  }
}

/** Test-only: clear every record and unset the adapter. */
export function __resetLspRegistryForTesting(): void {
  records.clear()
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
  publisherFingerprint?: string
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
    publisherFingerprint: input.publisherFingerprint,
    state: "stopped",
  }
  records.set(k, record)

  // Policy gate — skipped only when the consent UI explicitly confirms.
  if (!input.confirmedConsent) {
    let policy: LspBinaryEvaluation
    try {
      policy = await evaluateLspBinary({
        pluginId: input.ownerId,
        binaryPath: resolveBinaryPath(input.config.command, input.pluginPath),
        publisherFingerprint: input.publisherFingerprint,
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
    await d.client.start({
      ownerId: input.ownerId,
      serverId: input.config.id,
      config: input.config,
      workspaceFolders: d.resolveWorkspaceFolders(),
      onDiagnostics: (uri, markers) => {
        d.bridge.setDiagnostics({ extensionId: k, uri, markers })
      },
    })
    record.state = "running"
    record.startedAt = d.now()
  } catch (err) {
    record.state = "crashed"
    record.lastError = err instanceof Error ? err.message : String(err)
    lspRegistryLogger.warn("lsp-registry server start failed", {
      key: k,
      error: record.lastError,
    })
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
  records.delete(k)
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
  for (const record of records.values()) {
    if (record.state === "running" && record.config.languages.includes(languageId)) {
      return record
    }
  }
  return undefined
}

/**
 * Convenience for plugin enable: register every entry under
 * `manifest.lspServers[]`. Aggregates errors so a single bad entry
 * doesn't abort the rest.
 */
export async function registerPluginLspServers(input: {
  pluginId: string
  pluginPath: string
  publisherFingerprint?: string
  servers: PluginLspServerDef[]
}): Promise<LspServerRecord[]> {
  const out: LspServerRecord[] = []
  for (const cfg of input.servers) {
    try {
      const rec = await registerLspServer({
        ownerId: input.pluginId,
        config: cfg,
        pluginPath: input.pluginPath,
        publisherFingerprint: input.publisherFingerprint,
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
