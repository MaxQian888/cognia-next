// CCSwitch interop types — mirrors the structs serialized by
// `src-tauri/src/ccswitch/db.rs`. Field names follow the Rust struct's
// `serde(rename = "...")` attributes; everything not marked optional is
// always present (the Rust side fills empty strings before dropping rows).

import type { AgentId } from "@/lib/claude/types"

/**
 * Shape of a single provider/subscription entry in `cc-switch.db`. CCSwitch
 * pre-fills 50+ providers (Anthropic, Kimi, DeepSeek, Qwen, …); users can
 * also add custom ones. Cognia-next reads but never writes.
 */
export interface CcswitchProvider {
  id: string
  name: string
  /** "claude" | "codex" | "gemini" | "opencode" | "openclaw" | other */
  kind?: string
  /**
   * The API key. Treat as a secret — don't log, don't preview in plaintext
   * outside the dialog where the user explicitly asks for "Show key".
   */
  apiKey?: string
  baseUrl?: string
  model?: string
  /** Free-form `sharedConfig` blob CCSwitch preserves across switches. */
  sharedConfig?: unknown
  notes?: string
}

export interface CcswitchMcpServer {
  id: string
  name: string
  transport?: string
  /** Full MCP server config exactly as CCSwitch stores it. */
  config?: Record<string, unknown> | unknown[] | string | number | boolean | null
  notes?: string
}

export interface CcswitchPrompt {
  id: string
  name: string
  content: string
  description?: string
  tags?: string[]
}

export interface CcswitchSkill {
  id: string
  name: string
  description?: string
  /** Markdown body. Empty when CCSwitch references the skill by external path. */
  content: string
  /** Filesystem path when the skill is stored outside the DB. */
  sourcePath?: string
}

export interface CcswitchCounts {
  providers: number
  mcpServers: number
  prompts: number
  skills: number
}

export interface CcswitchStatus {
  /** Resolved DB path on this OS, or null when home dir can't be found. */
  dbPath: string | null
  exists: boolean
  counts: CcswitchCounts
  /** Filled in when the file existed but couldn't be opened/queried. */
  error?: string
}

/**
 * Where a provider switch lands. Cognia-next is always included (the user
 * is initiating the switch from cognia-next's UI). `agents` lists the
 * external CLIs the user opted to mirror the switch into via the
 * "Use here & in…" picker.
 */
export interface SwitchScope {
  /** Always true in v1 — left explicit so the dialog can render it as a row. */
  cognia: true
  /** Per-switch user selection. Empty = cognia-next only. */
  agents: AgentId[]
}

/**
 * Preview of every change a switch will make. The dialog shows this verbatim
 * before the user confirms; nothing happens until `applySwitch` runs.
 */
export interface SwitchPlan {
  provider: CcswitchProvider
  scope: SwitchScope
  /** What changes inside cognia-next (Dexie + sidecar). */
  cogniaChanges: {
    apiKeyBefore?: string
    apiKeyAfter?: string
    baseUrlBefore?: string
    baseUrlAfter?: string
    /** "ccswitch:<id>" or "local". */
    activeProviderIdBefore?: string
    activeProviderIdAfter: string
    /** Whether the sidecar will be restarted (always true when key/URL change). */
    restartSidecar: boolean
  }
  /**
   * What changes per agent. Each entry describes the env block patch we
   * will apply to that agent's settings file. Agents we don't yet know how
   * to write to (anything other than `claude-code` in v1) are surfaced
   * with `unsupported: true` so the UI can grey them out.
   */
  agentChanges: AgentEnvPatch[]
}

export interface AgentEnvPatch {
  agentId: AgentId
  /** "~/.claude/settings.json" etc. — null when the path can't be resolved. */
  targetPath: string | null
  /** True when v1 doesn't yet support writing to this agent. */
  unsupported: boolean
  /** Human-readable description of why this row is greyed out. */
  unsupportedReason?: string
  /**
   * env-block deltas. `null` value = remove the key. Empty when this entry
   * is `unsupported`.
   */
  envUpdates: Array<{ key: string; value: string | null }>
}

/**
 * Outcome of `detectActive`. Tells the UI which CCSwitch provider is
 * currently active in each surface, so badges and the drift banner have
 * something to render.
 */
export interface ActiveProviderState {
  /** Active provider id in cognia-next's own SDK (`AppSettings.activeProviderId`). */
  cognia: string | undefined
  /** Per-agent active CCSwitch provider id (or `undefined` if no match). */
  agents: Partial<Record<AgentId, string | undefined>>
  /** True when cognia-next and any tracked agent disagree. */
  drift: boolean
}
