/**
 * The plugin contract's share of `lib/agent-config/types.ts`, which re-exports these.
 */
import type { InstructionSource } from "../claude/instructions/types"
import type {
  OwnerPromptDocument,
  PromptEditCapability,
  PromptResourceSource,
} from "../prompts/resources"
import type { PromptResourceKind } from "../prompts/types"

/** An owner the Prompt Center lists, or a markdown agent definition file. */
export type AgentConfigSurfaceSource = PromptResourceSource | "agent-file"

export interface AgentConfigSurface {
  /** Stable key: the Prompt Center resource key, or `agent-file:<dir>|<name>`. */
  key: string
  source: AgentConfigSurfaceSource
  /** What the text does when it loads (Prompt Center kind; agent files are `agent-definition`). */
  kind: PromptResourceKind | "agent-definition"
  /** Display name; a code slot's prompt id. */
  name: string
  /** Short secondary line (a Skill's description, a file's load layer). */
  detail?: string
  builtIn: boolean
  /** Differs from what shipped. */
  modified: boolean
  /** How a change is written: through the owner, a custom copy, an override, or not here. */
  edit: PromptEditCapability
  /** Position in the load order, for instruction and agent files (0 loads first). */
  loadOrder?: number
  /** Which discovery rule found an instruction file. */
  layer?: InstructionSource | "agent-dir"
  /** Absolute path of a file-backed surface. */
  path?: string
  /** For code slots. */
  promptId?: string
  group?: string
  /** A code slot whose definition is gone but whose override remains. */
  unavailable?: true
}

export interface AgentConfigSurfaceListing {
  /** The workspace the listing was resolved for; `null` is account-only. */
  workspaceId: string | null
  surfaces: AgentConfigSurface[]
  /** Owners that could not be read, so a caller can say so instead of showing less. */
  failed: AgentConfigSurfaceSource[]
}

/** Usage and validation facts of a Skill, alongside its text. */
export interface AgentConfigSkillFacts {
  description?: string
  status: "enabled" | "disabled"
  origin: string
  usageCount: number
  lastUsedAt?: number
  allowedTools?: string[]
  validationErrorCount: number
}

export interface AgentConfigSurfaceDocument {
  key: string
  text: string
  /** Precondition for {@link AgentConfigEdit.version}. Opaque to callers. */
  version?: string
  readOnlyReason?: OwnerPromptDocument["readOnlyReason"]
  /** What the text derives from (a variant's base, the shipped prompt a copy was made from). */
  baseText?: string
  skill?: AgentConfigSkillFacts
}

/** One hook handler, reduced to what it is without how it runs. */
export interface AgentConfigHookFact {
  scope: "user" | "project" | "local"
  event: string
  matcher?: string
  type: string
  /**
   * A label safe to show and send: the executable's base name for a command
   * hook, the server and tool for an MCP hook, the host for an HTTP hook.
   * Never arguments, environment, headers or prompt text.
   */
  label: string
}

export interface AgentConfigPermissionFact {
  origin: "cognia-tools" | "cognia-commands" | "claude-user" | "claude-project" | "claude-local"
  tool: string
  pattern: string
  verdict: string
}

export interface AgentConfigMcpServerFact {
  id: string
  name: string
  transport: string
  enabled: boolean
  /** A plugin contributed the server. */
  pluginOwned: boolean
}

export interface AgentConfigFacts {
  defaultModel?: string
  defaultProviderId?: string
  instructions: {
    enabled: boolean
    mode: "layered" | "nearest"
    fileNames: string[]
    includeGlobal: boolean
    maxFileBytes: number
    loadProjectAgents: boolean
  }
  /** False off the desktop, where the Claude settings files cannot be read. */
  hooksAvailable: boolean
  hooks: AgentConfigHookFact[]
  permissionRules: AgentConfigPermissionFact[]
  mcpServers: AgentConfigMcpServerFact[]
  skills: { total: number; enabled: number; builtIn: number }
}

export interface AgentConfigReferenceInput {
  workspaceId?: string | null
  /** Paths an instruction names, relative to the workspace's primary root or absolute inside a root. */
  paths?: string[]
  /** Package scripts an instruction names (`pnpm typecheck` → `typecheck`). */
  scripts?: string[]
}

export type AgentConfigPathStatus =
  /** Present inside the workspace. */
  | "exists"
  | "missing"
  /** Outside every workspace root: not probed. */
  | "outside"
  /** The path, or a directory on the way to it, is a symbolic link: not followed. */
  | "symlink"
  /** The host could not check (no desktop filesystem, no workspace). */
  | "unchecked"

export interface AgentConfigReferenceCheck {
  paths: Array<{ path: string; status: AgentConfigPathStatus }>
  scripts: Array<{ name: string; status: "defined" | "undefined" | "unchecked" }>
}

/** Who last touched a line, without who: the commit and its time only. */
export interface AgentConfigLineProvenance {
  line: number
  commit: string
  authoredAtMs: number
}

export interface AgentConfigEdit {
  key: string
  /** The complete new text. */
  text: string
  /** The document version the edit was made against. */
  version?: string
  workspaceId?: string | null
  /** One line shown to the user in the confirmation, e.g. "Remove 2 outdated rules". */
  summary: string
}

export interface AgentConfigApplyResult {
  /** The resource that now holds the text (a custom copy's key when one was created). */
  key: string
  /** The version after the write, for a follow-up edit. */
  version?: string
}
