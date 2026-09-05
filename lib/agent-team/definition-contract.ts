/**
 * The Squad definition contract, and the one migration that upgrades to it.
 *
 * ADR-0169: every Squad executes on the durable coordinator. There is no
 * runtime selector. `config.runtimeVersion` ("legacy" | "durable-v2") is
 * retired, together with the legacy manager branches it used to pick between.
 * What a definition needs to be RUNNABLE is therefore fixed: exactly one
 * primary repository binding and one immutable environment version.
 *
 * This module is the only place that knows how to bring an older definition
 * onto that contract. It is pure and idempotent on purpose, because it runs
 * from several boundaries and must give the same answer at each of them:
 *
 *   - the Dexie definition mirror, on hydration (`stores/agent/.../dexie-bridge.ts`)
 *   - the persisted store's `defaultConfig` and templates (`store.ts` migrate)
 *   - the paired-device sync ingress (`lib/sync/handlers/agent-team-definitions.ts`)
 *   - the plugin API, the workflow node inputs and the CLI (`stripLegacyRuntimeSelector`)
 *
 * Inference is deliberately conservative. A binding is inferred only when
 * exactly ONE deterministic candidate exists. Anything else is left absent and
 * surfaces as a `SquadReadiness` blocker (`./squad-readiness.ts`) rather than
 * being guessed. A wrong guess dispatches work into the wrong checkout. A
 * blocker is a sentence the user can act on.
 */

import type { AgentTeam, AgentTeamConfig, AgentTeamTemplate } from "@/types/agent/agent-team"
import type {
  AgentTeamEnvironmentRef,
  AgentTeamRepositoryBinding,
} from "@/types/agent/agent-team-runtime"

/**
 * Current contract revision.
 *
 *   1: implicit, the `runtimeVersion` era. Never stamped.
 *   2: durable-only. `runtimeVersion` dropped, bindings required to run.
 */
export const SQUAD_DEFINITION_CONTRACT_VERSION = 2

/** Retired keys that must never survive a boundary. */
const RETIRED_CONFIG_KEYS: readonly string[] = ["runtimeVersion"]

export type SquadBindingInference = "repository" | "environment"

export interface SquadBindingCandidates {
  /**
   * The single repository path a primary binding may be inferred from, when
   * the caller could determine exactly one. `undefined` means none or
   * ambiguous. The caller has already applied the one-candidate rule.
   */
  repositoryPath?: string
  /** The single enabled environment (latest version). Same rule. */
  environment?: AgentTeamEnvironmentRef
}

export interface SquadConfigMigration {
  config: AgentTeamConfig
  /** Anything at all differs from the input. */
  changed: boolean
  /** A retired key was present and dropped. */
  strippedLegacySelector: boolean
  /** Which bindings were inferred from candidates (never from a guess). */
  inferred: SquadBindingInference[]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isValidRepository(value: unknown): value is AgentTeamRepositoryBinding {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<AgentTeamRepositoryBinding>
  return (
    isNonEmptyString(row.id) &&
    (row.role === "primary" || row.role === "dependency") &&
    isNonEmptyString(row.path) &&
    typeof row.writable === "boolean"
  )
}

function isValidEnvironmentRef(value: unknown): value is AgentTeamEnvironmentRef {
  if (!value || typeof value !== "object") return false
  const ref = value as Partial<AgentTeamEnvironmentRef>
  return isNonEmptyString(ref.environmentId) && isNonEmptyString(ref.versionId)
}

/**
 * Drop retired runtime-selector keys from any config-shaped object.
 *
 * Applied at every API boundary that accepts a config from outside this
 * process (plugins, workflow inputs, CLI, sync). It does not upgrade anything
 * else. A boundary strips, the migration upgrades, so a caller that only has
 * a partial config can still call it safely.
 */
export function stripLegacyRuntimeSelector<T extends object>(
  config: T
): { config: T; stripped: boolean } {
  if (!config || typeof config !== "object") return { config, stripped: false }
  const source = config as Record<string, unknown>
  const present = RETIRED_CONFIG_KEYS.filter((key) => key in source)
  if (present.length === 0) return { config, stripped: false }
  const next: Record<string, unknown> = { ...source }
  for (const key of present) delete next[key]
  return { config: next as T, stripped: true }
}

/** Whether a config-shaped object still carries a retired selector. */
export function carriesLegacyRuntimeSelector(config: unknown): boolean {
  if (!config || typeof config !== "object") return false
  return RETIRED_CONFIG_KEYS.some((key) => key in (config as Record<string, unknown>))
}

/**
 * Upgrade one config to the current contract.
 *
 * Idempotent: feeding the output back in yields `changed: false`.
 */
export function migrateSquadConfig(
  input: Partial<AgentTeamConfig> | undefined,
  candidates: SquadBindingCandidates = {}
): SquadConfigMigration {
  const { config: stripped, stripped: strippedLegacySelector } = stripLegacyRuntimeSelector(
    (input ?? {}) as Partial<AgentTeamConfig>
  )
  const next: Record<string, unknown> = { ...stripped }
  let changed = strippedLegacySelector
  const inferred: SquadBindingInference[] = []

  if (next.writeMode !== "single-writer" && next.writeMode !== "isolated-parallel") {
    next.writeMode = "single-writer"
    changed = true
  }

  // Repositories: keep every valid binding, drop malformed ones, then infer a
  // primary only when none survives and exactly one candidate exists.
  const rawRepositories = Array.isArray(next.repositories) ? next.repositories : undefined
  const validRepositories = (rawRepositories ?? []).filter(isValidRepository)
  if (rawRepositories && validRepositories.length !== rawRepositories.length) changed = true
  const hasPrimary = validRepositories.some((repository) => repository.role === "primary")
  if (!hasPrimary) {
    const candidatePath = resolveRepositoryCandidate(
      typeof next.workingDir === "string" ? next.workingDir : undefined,
      candidates.repositoryPath
    )
    if (candidatePath) {
      validRepositories.unshift({
        id: "primary",
        role: "primary",
        path: candidatePath,
        writable: true,
      })
      inferred.push("repository")
      changed = true
    }
  }
  if (validRepositories.length > 0) {
    if (
      !rawRepositories ||
      rawRepositories.length !== validRepositories.length ||
      rawRepositories.some((entry, index) => entry !== validRepositories[index])
    ) {
      next.repositories = validRepositories
      changed = true
    }
  } else if ("repositories" in next) {
    delete next.repositories
    changed = true
  }

  // Environment: keep a valid ref, drop a malformed one, infer from the single
  // candidate when absent.
  if (next.environmentRef !== undefined && !isValidEnvironmentRef(next.environmentRef)) {
    delete next.environmentRef
    changed = true
  }
  if (next.environmentRef === undefined && candidates.environment) {
    next.environmentRef = { ...candidates.environment }
    inferred.push("environment")
    changed = true
  }

  if (next.contractVersion !== SQUAD_DEFINITION_CONTRACT_VERSION) {
    next.contractVersion = SQUAD_DEFINITION_CONTRACT_VERSION
    changed = true
  }

  return {
    config: next as unknown as AgentTeamConfig,
    changed,
    strippedLegacySelector,
    inferred,
  }
}

/**
 * The one-candidate rule for a primary repository.
 *
 * `workingDir` (what the Squad was configured with) and the workspace root
 * (what the caller found) are both candidates. One of them, or both naming the
 * same directory, is a deterministic answer. Two different directories is not.
 */
function resolveRepositoryCandidate(
  workingDir: string | undefined,
  workspaceRoot: string | undefined
): string | undefined {
  const own = isNonEmptyString(workingDir) ? workingDir.trim() : undefined
  const root = isNonEmptyString(workspaceRoot) ? workspaceRoot.trim() : undefined
  if (own && root && own !== root) return undefined
  return own ?? root
}

export interface SquadDefinitionMigration {
  team: AgentTeam
  changed: boolean
  strippedLegacySelector: boolean
  inferred: SquadBindingInference[]
}

/** Upgrade a whole Squad definition. Returns the same object when nothing changed. */
export function migrateSquadDefinition(
  team: AgentTeam,
  candidates: SquadBindingCandidates = {}
): SquadDefinitionMigration {
  const result = migrateSquadConfig(team.config, candidates)
  if (!result.changed) {
    return { team, changed: false, strippedLegacySelector: false, inferred: [] }
  }
  return {
    team: { ...team, config: result.config },
    changed: true,
    strippedLegacySelector: result.strippedLegacySelector,
    inferred: result.inferred,
  }
}

/**
 * Upgrade a template's config overrides.
 *
 * Templates are profile-shared blueprints: they carry no workspace, so nothing
 * is inferred for them. Only the retired selector is dropped. Bindings are
 * resolved when a template is instantiated into a workspace
 * (`instantiate-template.ts` through `createSquad`).
 */
export function migrateSquadTemplate(template: AgentTeamTemplate): {
  template: AgentTeamTemplate
  changed: boolean
} {
  if (!template.config) return { template, changed: false }
  const { config, stripped } = stripLegacyRuntimeSelector(template.config)
  if (!stripped) return { template, changed: false }
  return { template: { ...template, config }, changed: true }
}

/** Whether a definition is already on the current contract (no work to do). */
export function isOnCurrentSquadContract(config: Partial<AgentTeamConfig> | undefined): boolean {
  return (
    config?.contractVersion === SQUAD_DEFINITION_CONTRACT_VERSION &&
    !carriesLegacyRuntimeSelector(config)
  )
}
