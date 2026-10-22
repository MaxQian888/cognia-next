/**
 * The plugin contract's share of `lib/plugin/lsp/lsp-registry.ts`, which re-exports these.
 */

import type { PluginLspServerDef } from "../../../types/plugin/plugin"
import type { MonacoMarker } from "../vscode-shim/monaco-bridge"

export type LspServerOwner = string

// pluginId or "user"

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
    onDiagnostics(uri: string, markers: MonacoMarker[]): void
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
  setDiagnostics(input: { extensionId: string; uri: string; markers: MonacoMarker[] }): void
  onEditorChange?(
    listener: (event: {
      editorId: string
      uri: string
      kind: "open" | "close" | "change-selection" | "change-content" | "change-language"
    }) => void
  ): () => void
  getEditorById?(editorId: string):
    | {
        getModel(): { uri: string; language: string; getValue(): string } | null
      }
    | undefined
}

/** Public export so the user-managed settings UI can use the same composite key. */
export function lspServerKey(ownerId: LspServerOwner, serverId: string): string {
  return `${ownerId}:${serverId}`
}
