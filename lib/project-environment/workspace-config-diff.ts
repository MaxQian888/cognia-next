/**
 * What changed in a repository's `.cognia/workspace.json` since the version
 * the user approved.
 *
 * A changed configuration stops running until it is reviewed (ADR-0147), and
 * "review" used to mean reading the whole current file and comparing it with
 * a version the user approved weeks ago, from memory. The digest proves that
 * something changed; this says what, one entry per thing that can run or
 * take effect, so the one line that now pipes `curl` into a shell is not
 * buried in forty that did not move.
 *
 * Pure, so the panel's rendering and the rules for what counts as a change
 * are tested apart. Values are rendered as the plain strings the panel shows
 * verbatim: a configuration's variables are non-secret by definition (the
 * secrets are named in `requiredSecrets` and bound on the device), and a
 * script is the one thing a reviewer most needs to read exactly.
 */

import type { WorkspaceBaseSpec } from "@/lib/task-workspace/types"
import type { ProjectEnvironmentScript } from "@/types/project-environment"

import type { WorkspaceRepositoryConfigV1 } from "./workspace-config"

export type WorkspaceConfigChangeKind = "added" | "removed" | "changed"

/** Which part of the configuration an entry is about. Each has a label in `repoConfig.diff.field`. */
export type WorkspaceConfigChangeField =
  | "setup"
  | "setupOs"
  | "action"
  | "variable"
  | "requiredSecret"
  | "root"
  | "execution"
  | "base"
  | "capability"
  | "cacheLink"
  | "include"
  | "sparsePath"
  | "environment"

export interface WorkspaceConfigChange {
  /** Stable within one diff, for list keys and tests. */
  id: string
  field: WorkspaceConfigChangeField
  /** The entry within the field: an OS, an action's name, a variable, a path. */
  subject?: string
  kind: WorkspaceConfigChangeKind
  /** The approved value, absent for an addition. */
  before?: string
  /** The current value, absent for a removal. */
  after?: string
}

const OSES = ["macos", "windows", "linux"] as const

function change(
  field: WorkspaceConfigChangeField,
  subject: string | undefined,
  before: string | undefined,
  after: string | undefined
): WorkspaceConfigChange | null {
  if (before === after) return null
  const kind: WorkspaceConfigChangeKind =
    before === undefined ? "added" : after === undefined ? "removed" : "changed"
  return {
    id: subject === undefined ? field : `${field}:${subject}`,
    field,
    ...(subject !== undefined ? { subject } : {}),
    kind,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  }
}

/** A script, or undefined for an empty one (an empty script runs nothing). */
function script(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function scriptChanges(
  field: "setup",
  previous: ProjectEnvironmentScript,
  current: ProjectEnvironmentScript
): WorkspaceConfigChange[] {
  const out: WorkspaceConfigChange[] = []
  const main = change(field, undefined, script(previous.default), script(current.default))
  if (main) out.push(main)
  for (const os of OSES) {
    const entry = change("setupOs", os, script(previous.byOs?.[os]), script(current.byOs?.[os]))
    if (entry) out.push(entry)
  }
  return out
}

/** Set membership changes of a list of strings, one entry per added or removed item. */
function membership(
  field: WorkspaceConfigChangeField,
  previous: readonly string[],
  current: readonly string[]
): WorkspaceConfigChange[] {
  const before = new Set(previous)
  const after = new Set(current)
  const out: WorkspaceConfigChange[] = []
  for (const item of previous) {
    if (!after.has(item)) out.push(change(field, item, item, undefined)!)
  }
  for (const item of current) {
    if (!before.has(item)) out.push(change(field, item, undefined, item)!)
  }
  return out
}

/** Changes of a keyed record, one entry per key that was added, removed or changed. */
function keyed<T>(
  field: WorkspaceConfigChangeField,
  previous: ReadonlyMap<string, T>,
  current: ReadonlyMap<string, T>,
  render: (value: T) => string
): WorkspaceConfigChange[] {
  const out: WorkspaceConfigChange[] = []
  const keys = [...previous.keys(), ...[...current.keys()].filter((key) => !previous.has(key))]
  for (const key of keys) {
    const before = previous.get(key)
    const after = current.get(key)
    const entry = change(
      field,
      key,
      before === undefined ? undefined : render(before),
      after === undefined ? undefined : render(after)
    )
    if (entry) out.push(entry)
  }
  return out
}

export function describeBase(base: WorkspaceBaseSpec): string {
  switch (base.kind) {
    case "gitRef":
      return `${base.kind}: ${base.gitRef}`
    case "pullRequest":
      return `${base.kind}: ${base.provider} ${base.repo}#${base.number}`
    default:
      return base.kind
  }
}

/** A stable rendering for structures compared as a whole. */
function stable(value: unknown): string {
  return JSON.stringify(value, Object.keys(flattenKeys(value)).sort(), 2)
}

function flattenKeys(value: unknown, into: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) flattenKeys(item, into)
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      into[key] = true
      flattenKeys(inner, into)
    }
  }
  return into
}

/**
 * Every difference between the approved and the current configuration, in
 * the order a reviewer reads them: what runs (setup, actions), what it runs
 * with (variables, secrets), where (execution, base, roots), then what it
 * suggests (capabilities, provisioning paths) and its runtime environment.
 */
export function diffWorkspaceConfig(
  previous: WorkspaceRepositoryConfigV1,
  current: WorkspaceRepositoryConfigV1
): WorkspaceConfigChange[] {
  const out: WorkspaceConfigChange[] = []

  out.push(...scriptChanges("setup", previous.setup, current.setup))

  // Actions are matched by id, so a rename reads as a change of one action
  // rather than one removed and another added.
  const actionLabel = (action: WorkspaceRepositoryConfigV1["actions"][number]) =>
    [action.name, script(action.script.default) ?? ""]
      .concat(
        OSES.flatMap((os) => {
          const body = script(action.script.byOs?.[os])
          return body ? [`[${os}] ${body}`] : []
        })
      )
      .filter(Boolean)
      .join("\n")
  const actionsById = (config: WorkspaceRepositoryConfigV1) =>
    new Map(config.actions.map((action) => [action.id, action]))
  const previousActions = actionsById(previous)
  const currentActions = actionsById(current)
  for (const entry of keyed("action", previousActions, currentActions, actionLabel)) {
    // Name the action by what the reader sees, not its id.
    const action = currentActions.get(entry.subject!) ?? previousActions.get(entry.subject!)
    out.push({ ...entry, subject: action?.name || entry.subject })
  }

  out.push(
    ...keyed(
      "variable",
      new Map(Object.entries(previous.variables)),
      new Map(Object.entries(current.variables)),
      (value) => value
    )
  )
  out.push(...membership("requiredSecret", previous.requiredSecrets, current.requiredSecrets))

  const execution = change(
    "execution",
    undefined,
    previous.defaults.execution,
    current.defaults.execution
  )
  if (execution) out.push(execution)
  const base = change(
    "base",
    undefined,
    describeBase(previous.defaults.base),
    describeBase(current.defaults.base)
  )
  if (base) out.push(base)

  out.push(
    ...keyed(
      "root",
      new Map(previous.roots.map((root) => [root.path, root])),
      new Map(current.roots.map((root) => [root.path, root])),
      (root) => `${root.path} (${root.role})`
    )
  )

  const capabilities = (config: WorkspaceRepositoryConfigV1) =>
    new Map(
      Object.entries(config.capabilities).flatMap(([kind, overrides]) =>
        Object.entries(overrides ?? {}).map(([id, on]) => [`${kind}:${id}`, on] as const)
      )
    )
  out.push(
    ...keyed("capability", capabilities(previous), capabilities(current), (on) =>
      on ? "on" : "off"
    )
  )

  out.push(
    ...membership(
      "cacheLink",
      previous.cacheLinks.map((link) => `${link.source} → ${link.target}`),
      current.cacheLinks.map((link) => `${link.source} → ${link.target}`)
    )
  )
  out.push(...membership("include", previous.include, current.include))
  out.push(...membership("sparsePath", previous.sparsePaths, current.sparsePaths))

  const environment = change(
    "environment",
    undefined,
    previous.environment ? stable(previous.environment) : undefined,
    current.environment ? stable(current.environment) : undefined
  )
  if (environment) out.push(environment)

  return out
}
