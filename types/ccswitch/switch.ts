// CCSwitch interop types — switch planning + active-state projection.

import type { AgentId } from "@/lib/claude/types"

import type { CcswitchProvider } from "./provider"

/**
 * Where a provider switch lands. Cognia-next is always included (the user
 * is initiating the switch from cognia-next's UI). `agents` lists the
 * external CLIs the user opted to mirror the switch into via the
 * "Use here & in…" picker.
 */
export interface SwitchScope {
  /** Always true — left explicit so the dialog can render it as a row. */
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
   * to write to are surfaced with `unsupported: true` so the UI can grey
   * them out.
   */
  agentChanges: AgentEnvPatch[]
}

export interface AgentEnvPatch {
  agentId: AgentId
  /** "~/.claude/settings.json" etc. — null when the path can't be resolved. */
  targetPath: string | null
  /** True when we don't yet support writing to this agent. */
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
