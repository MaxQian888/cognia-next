import type { PluginPermission } from "./plugin"
import type { VsCodeContributions } from "./plugin-vscode"

export type PluginIdeTarget = "monaco" | "pro-ide"

export type PluginIdeProviderKind =
  | "command"
  | "completion"
  | "hover"
  | "definition"
  | "declaration"
  | "type-definition"
  | "implementation"
  | "references"
  | "document-highlight"
  | "document-symbol"
  | "workspace-symbol"
  | "code-action"
  | "code-lens"
  | "document-link"
  | "document-color"
  | "format-document"
  | "format-range"
  | "format-on-type"
  | "rename"
  | "folding-range"
  | "selection-range"
  | "signature-help"
  | "semantic-tokens-document"
  | "semantic-tokens-range"
  | "inline-completion"
  | "inline-values"
  | "inlay-hints"
  | "linked-editing-range"
  | "call-hierarchy"
  | "type-hierarchy"
  | "evaluatable-expression"
  | "document-drop-edit"
  | "document-paste-edit"
  | "text-document-content"
  | "file-system"
  | "tree-data"
  | "status-bar-item"
  | "text-editor-decoration"
  | "file-decoration"
  | "language-status-item"
  | "webview-view"
  | "custom-editor"
  | "webview-panel-serializer"
  | "terminal-profile"
  | "terminal-link"
  | "task"
  | "source-control"
  | "debug-configuration"
  | "debug-adapter"
  | "debug-tracker"
  | "test-controller"
  | "notebook-serializer"
  | "notebook-controller"
  | "notebook-cell-status-bar"
  | "comment-controller"
  | "authentication"
  | "uri-handler"
  | "chat-participant"
  | "language-model-chat-provider"
  | "language-model-tool"
  | "mcp-server-definition"

export interface PluginIdeProviderDeclaration {
  /** Plugin-local id. The compiler emits `cognia.<pluginId>.<id>`. */
  id: string
  kind: PluginIdeProviderKind
  selector?: unknown
  /** Exported handler name in the plugin's single Cognia business runtime. */
  handler: string
  permission?: PluginPermission
  /** Explicitly unavailable in Monaco because no equivalent host surface exists. */
  proIdeOnly?: boolean
  metadata?: Record<string, unknown>
}

export type PluginIdeExecutableSource =
  | { kind: "plugin-resource"; path: string; sha256: string }
  | { kind: "registered-tool"; tool: string }
  | { kind: "user-selected"; setting: string }

export interface PluginIdeExecutableResource {
  id: string
  source: PluginIdeExecutableSource
  args?: string[]
  allowedEnvironment?: string[]
  workingDirectory?: "workspace" | "plugin-data"
  timeoutMs?: number
  memoryLimitMb?: number
}

export interface PluginIdeProtocolServer {
  id: string
  executable: string
  transport: "stdio" | "socket" | "http" | "sse"
  /**
   * Required for direct socket/HTTP/SSE transports. Only loopback endpoints
   * are accepted; stdio MCP servers receive a platform-owned loopback relay.
   */
  endpoint?: string
  languages?: string[]
  initializationOptions?: unknown
}

export interface PluginIdeAgentProjection {
  id: string
  agentId: string
  name: string
  description?: string
  commands?: Array<{ name: string; description: string }>
}

export interface PluginIdeRequirements {
  codeApiVersion?: "1.128.0"
  brokerProtocol?: "^1.0.0"
  capabilities?: string[]
}

/** Stable author contract normalized before Monaco or proxy projection. */
export interface PluginIdeManifest {
  schemaVersion: 1
  targets: readonly PluginIdeTarget[]
  requirements?: PluginIdeRequirements
  contributions?: VsCodeContributions
  providers?: PluginIdeProviderDeclaration[]
  executables?: PluginIdeExecutableResource[]
  protocols?: {
    lsp?: PluginIdeProtocolServer[]
    dap?: PluginIdeProtocolServer[]
    mcp?: PluginIdeProtocolServer[]
  }
  agents?: PluginIdeAgentProjection[]
}

export interface NormalizedPluginIdeManifest extends PluginIdeManifest {
  requirements: Required<Pick<PluginIdeRequirements, "codeApiVersion" | "brokerProtocol">> &
    PluginIdeRequirements
  contributions: VsCodeContributions
  providers: PluginIdeProviderDeclaration[]
  executables: PluginIdeExecutableResource[]
  protocols: {
    lsp: PluginIdeProtocolServer[]
    dap: PluginIdeProtocolServer[]
    mcp: PluginIdeProtocolServer[]
  }
  agents: PluginIdeAgentProjection[]
}
