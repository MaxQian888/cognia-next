/**
 * The plugin contract's share of `lib/project-environment/workspace-config.ts`, which re-exports these.
 */
import type {
  ProjectEnvironmentAction,
  ProjectEnvironmentScript,
} from "../../types/project-environment"
import type { WorkspaceBaseSpec } from "../task-workspace/types"
import type { WorkspaceCapabilityOverlay } from "../workspace/capability-overlay"
import type { WorkspaceEnvironmentBlock } from "./environment-declaration"

export type WorkspaceConfigExecution = "local" | "worktree"

export type WorkspaceConfigRootRole = "primary" | "additional"

export interface WorkspaceConfigRoot {
  id: string
  path: string
  role: WorkspaceConfigRootRole
}

export interface WorkspaceConfigCacheLink {
  source: string
  target: string
}

/**
 * Capabilities the repository SUGGESTS for a workspace opened on it.
 *
 * Same shape as `WorkspaceCapabilityOverlay` (id → on/off, absent inherits),
 * because it feeds exactly that. It is a suggestion and never an instruction:
 * a repository telling a new contributor "this project uses the Jira server"
 * is useful, a repository silently deciding what tools an agent holds is not.
 * `seedCapabilityOverlay` applies it only where the workspace has no opinion
 * yet, so a user's own choice always survives the next `git pull`.
 */
export type WorkspaceConfigCapabilities = WorkspaceCapabilityOverlay

export interface WorkspaceRepositoryConfigV1 {
  version: 1
  roots: WorkspaceConfigRoot[]
  defaults: {
    execution: WorkspaceConfigExecution
    base: WorkspaceBaseSpec
  }
  setup: ProjectEnvironmentScript
  actions: ProjectEnvironmentAction[]
  variables: Record<string, string>
  sparsePaths: string[]
  cacheLinks: WorkspaceConfigCacheLink[]
  include: string[]
  requiredSecrets: string[]
  capabilities: WorkspaceConfigCapabilities
  /**
   * The runtime environment the repository declares (ADR-0182). Present only
   * when the file has an `environment` block — an absent key keeps the
   * ADR-0147 digest of every existing configuration unchanged. Approving the
   * configuration does not approve the environment: that has its own
   * declaration digest and approval.
   */
  environment?: WorkspaceEnvironmentBlock
  // `acceptanceProfiles` (ADR-0188 D15) is deliberately NOT a member. It is
  // read only by `readWorkspaceAcceptanceProfiles`, which only Router + Fusion
  // calls, so this shape, `parseWorkspaceConfig` and the ADR-0147 digest are
  // byte-identical for every file, with or without the block.
}
