import type {
  AdapterCredentials,
  CodeAdapterSpec,
  OpenAiCompatibleVariantSpec,
} from "./protocol-adapters.ts"
import type { ConversationMessage } from "./conversation.ts"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeAgentSdkOptionsV1 } from "@cognia/agent-config-types/claude-agent-sdk-options"

/** Host-visible fields; rail-owned options remain additive on the wire. */
export interface SendOptions {
  turnId?: string
  cwd?: string
  provider?: string
  model?: string
  permissionMode?: Options["permissionMode"]
  toolSurface?: string
  systemPrompt?: unknown
  appendSystemPrompt?: unknown
  agents?: Options["agents"]
  pluginTools?: readonly {
    name: string
    description?: string
    jsonSchema?: unknown
    pluginId?: string
    manifestPath?: string
    timeoutMs?: unknown
  }[]
  ledger?: { mode?: string; runId?: string; envelopeMaxBudgetUsd?: number; [key: string]: unknown }
  claudeAgentSdk?: ClaudeAgentSdkOptionsV1
  execution?: {
    identity?: { runId?: string; attemptId?: string; parentRunId?: string }
    tenantId?: string
    modelBindings?: { primary?: string; fast?: string }
    composition?: { toolPresentation?: string; presetId?: string; compositionDigest?: string }
    route?: { kind?: string; endpoint?: string }
    hostRef?: string
    runtimeAdapter?: string
  }
  fallbackModel?: string
  resumeSessionId?: string
  forkFromSessionId?: string
  resume?: string
  forkSession?: boolean
  maxBudgetUsd?: number
  maxTurns?: number
  maxThinkingTokens?: number
  traceparent?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  additionalDirectories?: string[]
  trustedWorkspaceRoots?: string[]
  builtinTools?: Record<string, boolean | undefined>
  builtinProcessSandbox?: {
    launcher?: string
    writableRoots: readonly string[]
    readableRoots?: readonly string[]
    network?: boolean
    unavailableReason?: string
    [key: string]: unknown
  }
  backgroundProcessHost?: string
  codeGraph?: { watch?: boolean }
  lsp?: Record<string, unknown>
  mcpServers?: Options["mcpServers"]
  mcpDeclaredBy?: Record<string, string>
  env?: Record<string, string | undefined>
  appendHeaders?: Record<string, string>
  planTools?: boolean
  toolExecutionTimeoutMs?: number
  providerCredentials?: AdapterCredentials
  modelParams?: Record<string, unknown>
  protocolAdapterSpec?: CodeAdapterSpec | OpenAiCompatibleVariantSpec
  initialConversation?: ConversationMessage[]
  traceId?: string
  projectId?: string
  compaction?: {
    maxToolResultTokens?: number
    enabled?: boolean
    trigger?: string
    messageCountThreshold?: number
    contextWindow?: number
    fraction?: number
    strategy?: string
    keepRecent?: number
    preserveSystemMessages?: boolean
    recursiveChunkSize?: number
    importanceThreshold?: number
    retainedFraction?: number
    summaryPrompt?: string
    useAISummarization?: boolean
    maxSummaryTokens?: number
    enableUndo?: boolean
    summarizeToolResults?: boolean
    preserveToolCallMetadata?: boolean
    summary?: {
      model?: string
      providerId?: string
      credentials?: AdapterCredentials
      protocol?: string
      protocolAdapterSpec?: CodeAdapterSpec | OpenAiCompatibleVariantSpec
    }
    optical?: import("./optical-options.ts").OpticalCompactionOptions
    [key: string]: unknown
  }
  toolSearchEnabled?: boolean
  alwaysLoadServers?: string[]
  alwaysLoadTools?: string[]
  includePartialMessages?: boolean
  settingSources?: Options["settingSources"]
  agent?: string
  forwardSubagentText?: boolean
  strictMcpConfig?: boolean
  effort?: Options["effort"]
  bypassPermissionsConfirmed?: boolean
  agentKind?: string
  agentRef?: string
  telemetry?: { child?: boolean; enhanced?: boolean }
  hooks?: Record<string, { matcher?: string; agents?: string; hooks?: Record<string, unknown>[] }[]>
  [key: string]: unknown
}
export type Prompt = string | unknown[]
export interface HostCommand {
  type: string
  sessionId?: string
  commandId?: string
  options?: SendOptions
  [key: string]: unknown
}
