/**
 * Agent Mode type definitions
 * Defines different agent sub-modes like web design, code generation, etc.
 *
 * The shipped modes themselves live in `lib/agent/modes/built-ins.ts`: a type
 * module does not own an editable runtime catalogue.
 */

import type { AgentModeType } from "@cognia/provider-types/agent-mode"
export type { AgentModeType } from "@cognia/provider-types/agent-mode"

export interface AgentModeConfig {
  id: string
  type: AgentModeType
  name: string
  description: string
  icon: string // Lucide icon name
  systemPrompt?: string
  tools?: string[] // Available tools for this mode
  outputFormat?: "text" | "code" | "html" | "react" | "markdown"
  previewEnabled?: boolean
  /**
   * SDK permission mode this agent mode enforces. `"plan"` makes the agent
   * read-only (edits / mutating commands are blocked by the SDK); `"build"`
   * uses `"acceptEdits"`. Flows into `SendOptions.permissionMode` via
   * `lib/claude/build-options.ts`. Mirrors OpenCode's plan/build modes —
   * the same agent loop, a different permission ruleset.
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"
  customConfig?: Record<string, unknown>
}

export interface CustomAgentMode extends AgentModeConfig {
  type: "custom"
  createdAt: Date
  updatedAt: Date
  isBuiltIn: false
}
