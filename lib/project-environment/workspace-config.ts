import type { WorkspaceBaseSpec } from "@/lib/task-workspace/types"
import {
  WORKSPACE_CAPABILITY_KINDS,
  type WorkspaceCapabilityKind,
  type WorkspaceCapabilityOverlay,
} from "@/lib/workspace/capability-overlay"
import type {
  ProjectEnvironment,
  ProjectEnvironmentAction,
  ProjectEnvironmentScript,
} from "@/types/project-environment"

export const WORKSPACE_CONFIG_PATH = ".cognia/workspace.json"
export const WORKSPACE_CONFIG_MAX_BYTES = 256 * 1024

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
}

export interface ResolvedProjectEnvironment {
  environment: ProjectEnvironment
  repositoryConfig: WorkspaceRepositoryConfigV1
  missingSecretVariables: string[]
  /**
   * Variables the repository declared and this device overrides. Rendered by
   * the environment panel: "local wins" is only a safe rule while the user can
   * see where it took effect and put the repository's value back.
   */
  overriddenVariables: string[]
}

export class WorkspaceConfigError extends Error {
  constructor(
    message: string,
    readonly field = "workspace.json"
  ) {
    super(message)
    this.name = "WorkspaceConfigError"
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceConfigError(`${field} must be an object`, field)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceConfigError(`${field} must be a non-empty string`, field)
  }
  return value.trim()
}

function relativePath(value: unknown, field: string): string {
  const path = text(value, field).replaceAll("\\", "/")
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((segment) => segment === "..")
  ) {
    throw new WorkspaceConfigError(`${field} must be a confined relative path`, field)
  }
  return path
}

function stringArray(value: unknown, field: string, paths = false): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new WorkspaceConfigError(`${field} must be an array`, field)
  const values = value.map((entry, index) =>
    paths ? relativePath(entry, `${field}[${index}]`) : text(entry, `${field}[${index}]`)
  )
  if (new Set(values).size !== values.length) {
    throw new WorkspaceConfigError(`${field} contains duplicate entries`, field)
  }
  return values
}

function script(value: unknown, field: string): ProjectEnvironmentScript {
  if (value === undefined) return { default: "" }
  const row = object(value, field)
  const fallback = typeof row.default === "string" ? row.default : ""
  const byOs = row.byOs === undefined ? undefined : object(row.byOs, `${field}.byOs`)
  return {
    default: fallback,
    ...(byOs
      ? {
          byOs: Object.fromEntries(
            Object.entries(byOs).map(([os, command]) => {
              if (!(["macos", "windows", "linux"] as const).includes(os as never)) {
                throw new WorkspaceConfigError(`Unsupported OS override: ${os}`, `${field}.byOs`)
              }
              if (typeof command !== "string") {
                throw new WorkspaceConfigError(`${field}.byOs.${os} must be a string`)
              }
              return [os, command]
            })
          ),
        }
      : {}),
  }
}

function capabilities(value: unknown): WorkspaceConfigCapabilities {
  if (value === undefined) return {}
  const row = object(value, "capabilities")
  const out: WorkspaceConfigCapabilities = {}
  for (const [kind, entries] of Object.entries(row)) {
    if (!(WORKSPACE_CAPABILITY_KINDS as readonly string[]).includes(kind)) {
      // Loud rather than ignored: a typo'd kind silently doing nothing is how
      // a repository ends up believing it configured something it did not.
      throw new WorkspaceConfigError(`Unsupported capability kind: ${kind}`, "capabilities")
    }
    const byId = object(entries, `capabilities.${kind}`)
    const normalized: Record<string, boolean> = {}
    for (const [id, state] of Object.entries(byId)) {
      if (typeof state !== "boolean") {
        throw new WorkspaceConfigError(
          `capabilities.${kind}.${id} must be true or false`,
          `capabilities.${kind}`
        )
      }
      const trimmed = text(id, `capabilities.${kind}`)
      normalized[trimmed] = state
    }
    if (Object.keys(normalized).length) out[kind as WorkspaceCapabilityKind] = normalized
  }
  return out
}

function baseSpec(value: unknown): WorkspaceBaseSpec {
  if (value === undefined) return { kind: "workingState" }
  const row = object(value, "defaults.base")
  const kind = text(row.kind, "defaults.base.kind")
  if (["workingState", "localHead", "remoteDefault"].includes(kind)) {
    return { kind } as WorkspaceBaseSpec
  }
  if (kind === "gitRef") return { kind, gitRef: text(row.gitRef, "defaults.base.gitRef") }
  if (kind === "pullRequest") {
    const number = row.number
    if (!Number.isSafeInteger(number) || Number(number) <= 0) {
      throw new WorkspaceConfigError("defaults.base.number must be a positive integer")
    }
    return {
      kind,
      provider: text(row.provider, "defaults.base.provider"),
      repo: text(row.repo, "defaults.base.repo"),
      number: Number(number),
    }
  }
  throw new WorkspaceConfigError(`Unsupported workspace base kind: ${kind}`)
}

export function parseWorkspaceConfig(source: string): WorkspaceRepositoryConfigV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    throw new WorkspaceConfigError(
      `workspace.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  const row = object(parsed, "workspace.json")
  if (row.version !== 1)
    throw new WorkspaceConfigError("workspace.json version must be 1", "version")

  const roots = row.roots === undefined ? [] : row.roots
  if (!Array.isArray(roots)) throw new WorkspaceConfigError("roots must be an array", "roots")
  const normalizedRoots = roots.map((entry, index): WorkspaceConfigRoot => {
    const root = object(entry, `roots[${index}]`)
    const role = root.role ?? (index === 0 ? "primary" : "additional")
    if (role !== "primary" && role !== "additional") {
      throw new WorkspaceConfigError(`roots[${index}].role is invalid`)
    }
    return {
      id: text(root.id, `roots[${index}].id`),
      path: relativePath(root.path ?? ".", `roots[${index}].path`),
      role,
    }
  })
  if (new Set(normalizedRoots.map((root) => root.id)).size !== normalizedRoots.length) {
    throw new WorkspaceConfigError("roots contains duplicate ids", "roots")
  }
  if (
    normalizedRoots.length &&
    normalizedRoots.filter((root) => root.role === "primary").length !== 1
  ) {
    throw new WorkspaceConfigError("roots must contain exactly one primary root", "roots")
  }

  const defaults = row.defaults === undefined ? {} : object(row.defaults, "defaults")
  const execution = defaults.execution ?? "worktree"
  if (execution !== "local" && execution !== "worktree") {
    throw new WorkspaceConfigError("defaults.execution must be local or worktree")
  }
  const actionsValue = row.actions ?? []
  if (!Array.isArray(actionsValue)) throw new WorkspaceConfigError("actions must be an array")
  const actions = actionsValue.map((entry, index): ProjectEnvironmentAction => {
    const action = object(entry, `actions[${index}]`)
    return {
      id: text(action.id, `actions[${index}].id`),
      name: text(action.name, `actions[${index}].name`),
      ...(typeof action.icon === "string" ? { icon: action.icon } : {}),
      script: script(action.script, `actions[${index}].script`),
    }
  })
  if (new Set(actions.map((action) => action.id)).size !== actions.length) {
    throw new WorkspaceConfigError("actions contains duplicate ids", "actions")
  }

  const variablesValue = row.variables === undefined ? {} : object(row.variables, "variables")
  const variables = Object.fromEntries(
    Object.entries(variablesValue).map(([key, value]) => {
      if (typeof value !== "string")
        throw new WorkspaceConfigError(`variables.${key} must be a string`)
      return [key, value]
    })
  )
  const cacheLinksValue = row.cacheLinks ?? []
  if (!Array.isArray(cacheLinksValue)) throw new WorkspaceConfigError("cacheLinks must be an array")
  const cacheLinks = cacheLinksValue.map((entry, index) => {
    const link = object(entry, `cacheLinks[${index}]`)
    return {
      source: relativePath(link.source, `cacheLinks[${index}].source`),
      target: relativePath(link.target, `cacheLinks[${index}].target`),
    }
  })

  return {
    version: 1,
    roots: normalizedRoots,
    defaults: { execution, base: baseSpec(defaults.base) },
    setup: script(row.setup, "setup"),
    actions,
    variables,
    sparsePaths: stringArray(row.sparsePaths, "sparsePaths", true),
    cacheLinks,
    include: stringArray(row.include, "include", true),
    requiredSecrets: stringArray(row.requiredSecrets, "requiredSecrets"),
    capabilities: capabilities(row.capabilities),
  }
}

export function mergeWorkspaceConfig(
  local: ProjectEnvironment,
  config: WorkspaceRepositoryConfigV1,
  now = Date.now()
): ResolvedProjectEnvironment {
  const boundSecrets = new Set(local.keyringReferences.map((reference) => reference.variable))
  return {
    environment: {
      ...local,
      setupScript: config.setup,
      actions: config.actions,
      // Local wins. Both sides configure the SAME workspace; the difference is
      // "this device" versus "shared with the repository", and the more
      // specific layer has to win — otherwise a value the user set for their
      // own machine stops working silently on the next `git pull`, with
      // nothing on screen to connect the two. `overriddenVariables` below is
      // what keeps that from being invisible in the other direction.
      variables: { ...config.variables, ...local.variables },
      updatedAt: now,
    },
    repositoryConfig: config,
    missingSecretVariables: config.requiredSecrets.filter(
      (variable) => !boundSecrets.has(variable)
    ),
    overriddenVariables: Object.keys(config.variables).filter(
      (name) => name in local.variables && local.variables[name] !== config.variables[name]
    ),
  }
}

export async function readWorkspaceConfig(
  root: string,
  read: (root: string, relativePath: string, maxBytes: number) => Promise<string>
): Promise<WorkspaceRepositoryConfigV1 | null> {
  try {
    return parseWorkspaceConfig(await read(root, WORKSPACE_CONFIG_PATH, WORKSPACE_CONFIG_MAX_BYTES))
  } catch (cause) {
    if (cause instanceof WorkspaceConfigError) throw cause
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/not found|no such file|does not exist/i.test(message)) return null
    throw new WorkspaceConfigError(`Unable to read workspace.json: ${message}`)
  }
}
