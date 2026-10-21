/**
 * The plugin contract's share of `lib/plugin/api/external-agents-changes.ts`, which re-exports these.
 */
export type ExternalAgentChangeType =
  | "config-added"
  | "config-updated"
  | "config-removed"
  | "connection-changed"
  | "settings-changed"
  | "delegation-changed"

export interface ExternalAgentChangeEvent {
  type: ExternalAgentChangeType
  /** The configuration the change concerns; absent for settings and delegation changes. */
  agentId?: string
}
