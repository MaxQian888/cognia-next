import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser"

import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"
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

import {
  parseWorkspaceEnvironmentBlock,
  type DeclarationProblem,
  type WorkspaceEnvironmentBlock,
} from "./environment-declaration"

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
    readonly field = "workspace.json",
    /** Every problem found in the `environment` block, when that is what failed. */
    readonly problems: DeclarationProblem[] = []
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

  let environment: WorkspaceEnvironmentBlock | undefined
  if (row.environment !== undefined) {
    const parsed = parseWorkspaceEnvironmentBlock(row.environment)
    if (!parsed.ok) {
      const [first] = parsed.problems
      throw new WorkspaceConfigError(
        `environment is invalid: ${parsed.problems.map((problem) => `${problem.code} at ${problem.field}`).join(", ")}`,
        first?.field ?? "environment",
        parsed.problems
      )
    }
    environment = parsed.block
  }

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
    ...(environment ? { environment } : {}),
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

// ── Acceptance profiles (ADR-0188 D15) ─────────────────────────────────────
//
// Router + Fusion's delegate mode accepts a worker's patch only on a tool
// report, never on the worker's claim (DEL-01). The command that produces the
// report is declared by the repository, in this same file:
//
//   "acceptanceProfiles": {
//     "unit": {
//       "command": ["pnpm", "exec", "jest", "--ci", "--json", "--outputFile=reports/jest.json"],
//       "cwd": ".",
//       "report": { "format": "json", "path": "reports/jest.json" },
//       "requiredTests": ["auth logs in"],
//       "timeoutMs": 300000
//     }
//   }
//
// Read only when Router + Fusion asks. The block is not part of
// `WorkspaceRepositoryConfigV1`: `parseWorkspaceConfig` never looks at it, so
// with Router + Fusion off a file with or without the block (even a malformed
// one) parses, digests and approves exactly as before.
// `readWorkspaceAcceptanceProfiles` is the only reader.
//
// Strict and closed-world. Every key is known or refused, and every problem
// names its location as an RFC 6901 JSON pointer, all problems at once. The
// text goes through `jsonc-parser` in tree mode (comments and trailing commas
// off: the file is JSON) instead of `JSON.parse`, because `JSON.parse` keeps
// the LAST of two duplicate keys without a word, so a reviewer reading the
// first `command` would approve one thing while another ran. Duplicates are
// refused.
//
// The project override is the rule `mergeWorkspaceConfig` already applies to
// variables: local wins. A project may carry its own profiles on its row
// (`Project.metadata[PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY]`, same strict
// shape), a profile it defines replaces the repository's profile of the same
// id, and `overriddenProfiles` names every repository profile it shadows so
// the override is never invisible. Whichever side a profile comes from, it
// runs only once approved at its command hash (`workspace-config-trust.ts`).

/** The top-level key in `.cognia/workspace.json`. */
export const ACCEPTANCE_PROFILES_KEY = "acceptanceProfiles"

/**
 * Where a project's own acceptance profiles live: `Project.metadata[key]`.
 * Namespaced because `metadata` is an open bag that plugins also write.
 */
export const PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY = "cognia.acceptanceProfiles"

export const ACCEPTANCE_PROFILE_LIMITS = {
  maxProfiles: 32,
  maxCommandArgs: 128,
  maxArgLength: 4096,
  maxRequiredTests: 512,
  minTimeoutMs: 1_000,
  /**
   * A delegate run's whole deadline is at most 900 s (`builtin-catalog.ts`),
   * so no single acceptance run may be declared to outlive it.
   */
  maxTimeoutMs: 900_000,
  defaultTimeoutMs: 300_000,
} as const

export const ACCEPTANCE_REPORT_FORMATS = ["junit", "json"] as const
export type AcceptanceReportFormat = (typeof ACCEPTANCE_REPORT_FORMATS)[number]

const ACCEPTANCE_PROFILE_FIELDS: ReadonlySet<string> = new Set([
  "command",
  "cwd",
  "report",
  "requiredTests",
  "timeoutMs",
])
const ACCEPTANCE_REPORT_FIELDS: ReadonlySet<string> = new Set(["format", "path"])
/** Ids end up in keys, pointers, approvals and the UI: a conservative alphabet. */
const ACCEPTANCE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** One acceptance profile, normalized. Both sources parse to exactly this. */
export interface WorkspaceAcceptanceProfile {
  /** argv, run without a shell. `command[0]` names the program. */
  command: string[]
  /** Repository-relative working directory, normalized; `.` when omitted. */
  cwd: string
  /** The report the command writes, repository-relative, normalized. */
  report: { format: AcceptanceReportFormat; path: string }
  /** Test ids that must be discovered and not skipped. `[]` when omitted. */
  requiredTests: string[]
  /** Wall-clock limit of one run. `ACCEPTANCE_PROFILE_LIMITS.defaultTimeoutMs` when omitted. */
  timeoutMs: number
}

export type WorkspaceAcceptanceProfiles = Record<string, WorkspaceAcceptanceProfile>

export type AcceptanceProfileProblemCode =
  | "acceptance_profiles_document_invalid"
  | "acceptance_profiles_not_object"
  | "acceptance_profiles_too_many"
  | "acceptance_profile_key_duplicate"
  | "acceptance_profile_id_invalid"
  | "acceptance_profile_not_object"
  | "acceptance_profile_field_unknown"
  | "acceptance_profile_field_missing"
  | "acceptance_profile_command_invalid"
  | "acceptance_profile_path_invalid"
  | "acceptance_profile_path_sensitive"
  | "acceptance_profile_report_invalid"
  | "acceptance_profile_report_format_invalid"
  | "acceptance_profile_required_tests_invalid"
  | "acceptance_profile_timeout_invalid"

export interface AcceptanceProfileProblem {
  code: AcceptanceProfileProblemCode
  /** RFC 6901 JSON pointer into the document the value came from. */
  pointer: string
  message: string
}

export type AcceptanceProfilesParseResult =
  | { ok: true; profiles: WorkspaceAcceptanceProfiles }
  | { ok: false; problems: AcceptanceProfileProblem[] }

/** Append RFC 6901 reference tokens (`~` → `~0`, `/` → `~1`) to a pointer. */
export function jsonPointer(base: string, ...tokens: ReadonlyArray<string | number>): string {
  return tokens.reduce<string>(
    (pointer, token) => `${pointer}/${String(token).replaceAll("~", "~0").replaceAll("/", "~1")}`,
    base
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * A repository-relative path, normalized (`\` → `/`, `.` and empty segments
 * dropped), or null when it could leave the checkout: absolute, a drive
 * letter, `~`, a `..` segment, or a NUL byte. `.` (the root) only when
 * `allowRoot`: a working directory may be the root, a report file may not.
 */
function confinedAcceptancePath(value: string, allowRoot: boolean): string | null {
  if (value.includes("\0")) return null
  const path = value.trim().replaceAll("\\", "/")
  if (!path) return null
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) return null
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".")
  if (segments.some((segment) => segment === "..")) return null
  const normalized = segments.join("/")
  if (!normalized) return allowRoot ? "." : null
  return normalized
}

function acceptanceProfile(
  value: unknown,
  pointer: string,
  problems: AcceptanceProfileProblem[]
): WorkspaceAcceptanceProfile | null {
  const before = problems.length
  const problem = (code: AcceptanceProfileProblemCode, at: string, message: string) =>
    problems.push({ code, pointer: at, message })
  if (!isRecord(value)) {
    problem("acceptance_profile_not_object", pointer, "an acceptance profile must be an object")
    return null
  }
  for (const key of Object.keys(value)) {
    if (!ACCEPTANCE_PROFILE_FIELDS.has(key)) {
      problem(
        "acceptance_profile_field_unknown",
        jsonPointer(pointer, key),
        `unknown field "${key}"`
      )
    }
  }

  const command: string[] = []
  const commandAt = jsonPointer(pointer, "command")
  if (value.command === undefined) {
    problem("acceptance_profile_field_missing", commandAt, "command is required")
  } else if (!Array.isArray(value.command) || value.command.length === 0) {
    problem(
      "acceptance_profile_command_invalid",
      commandAt,
      "command must be a non-empty array of strings (argv, no shell)"
    )
  } else if (value.command.length > ACCEPTANCE_PROFILE_LIMITS.maxCommandArgs) {
    problem(
      "acceptance_profile_command_invalid",
      commandAt,
      `command has more than ${ACCEPTANCE_PROFILE_LIMITS.maxCommandArgs} arguments`
    )
  } else {
    value.command.forEach((arg: unknown, index: number) => {
      const at = jsonPointer(commandAt, index)
      if (typeof arg !== "string") {
        problem("acceptance_profile_command_invalid", at, "every command argument must be a string")
      } else if (arg.includes("\0")) {
        problem("acceptance_profile_command_invalid", at, "a command argument must not contain NUL")
      } else if (arg.length > ACCEPTANCE_PROFILE_LIMITS.maxArgLength) {
        problem(
          "acceptance_profile_command_invalid",
          at,
          `a command argument is longer than ${ACCEPTANCE_PROFILE_LIMITS.maxArgLength} characters`
        )
      } else if (index === 0 && !arg.trim()) {
        problem(
          "acceptance_profile_command_invalid",
          at,
          "the first argument must name the program"
        )
      } else {
        command.push(arg)
      }
    })
  }

  let cwd = "."
  if (value.cwd !== undefined) {
    const at = jsonPointer(pointer, "cwd")
    const normalized =
      typeof value.cwd === "string" ? confinedAcceptancePath(value.cwd, true) : null
    if (normalized === null) {
      problem(
        "acceptance_profile_path_invalid",
        at,
        "cwd must be a repository-relative path without `..`"
      )
    } else {
      cwd = normalized
    }
  }

  let report: WorkspaceAcceptanceProfile["report"] | null = null
  const reportAt = jsonPointer(pointer, "report")
  if (value.report === undefined) {
    problem("acceptance_profile_field_missing", reportAt, "report is required")
  } else if (!isRecord(value.report)) {
    problem(
      "acceptance_profile_report_invalid",
      reportAt,
      "report must be an object with format and path"
    )
  } else {
    const row = value.report
    for (const key of Object.keys(row)) {
      if (!ACCEPTANCE_REPORT_FIELDS.has(key)) {
        problem(
          "acceptance_profile_field_unknown",
          jsonPointer(reportAt, key),
          `unknown field "${key}"`
        )
      }
    }
    const formatAt = jsonPointer(reportAt, "format")
    let format: AcceptanceReportFormat | null = null
    if (row.format === undefined) {
      problem("acceptance_profile_field_missing", formatAt, "report.format is required")
    } else if (!(ACCEPTANCE_REPORT_FORMATS as readonly unknown[]).includes(row.format)) {
      problem(
        "acceptance_profile_report_format_invalid",
        formatAt,
        `report.format must be one of ${ACCEPTANCE_REPORT_FORMATS.join(", ")}`
      )
    } else {
      format = row.format as AcceptanceReportFormat
    }
    const pathAt = jsonPointer(reportAt, "path")
    let path: string | null = null
    if (row.path === undefined) {
      problem("acceptance_profile_field_missing", pathAt, "report.path is required")
    } else {
      const normalized =
        typeof row.path === "string" ? confinedAcceptancePath(row.path, false) : null
      if (normalized === null) {
        problem(
          "acceptance_profile_path_invalid",
          pathAt,
          "report.path must name a file by a repository-relative path without `..`"
        )
      } else if (isSensitiveResourcePath(normalized)) {
        problem(
          "acceptance_profile_path_sensitive",
          pathAt,
          "report.path must not name a credential-shaped file"
        )
      } else {
        path = normalized
      }
    }
    if (format && path) report = { format, path }
  }

  const requiredTests: string[] = []
  if (value.requiredTests !== undefined) {
    const at = jsonPointer(pointer, "requiredTests")
    if (!Array.isArray(value.requiredTests)) {
      problem(
        "acceptance_profile_required_tests_invalid",
        at,
        "requiredTests must be an array of test ids"
      )
    } else if (value.requiredTests.length > ACCEPTANCE_PROFILE_LIMITS.maxRequiredTests) {
      problem(
        "acceptance_profile_required_tests_invalid",
        at,
        `requiredTests has more than ${ACCEPTANCE_PROFILE_LIMITS.maxRequiredTests} entries`
      )
    } else {
      value.requiredTests.forEach((entry: unknown, index: number) => {
        const entryAt = jsonPointer(at, index)
        // Kept verbatim: a test id is matched exactly against the report.
        if (typeof entry !== "string" || !entry.trim()) {
          problem(
            "acceptance_profile_required_tests_invalid",
            entryAt,
            "every required test id must be a non-empty string"
          )
        } else if (requiredTests.includes(entry)) {
          problem(
            "acceptance_profile_required_tests_invalid",
            entryAt,
            `duplicate test id "${entry}"`
          )
        } else {
          requiredTests.push(entry)
        }
      })
    }
  }

  let timeoutMs: number = ACCEPTANCE_PROFILE_LIMITS.defaultTimeoutMs
  if (value.timeoutMs !== undefined) {
    const at = jsonPointer(pointer, "timeoutMs")
    const { minTimeoutMs, maxTimeoutMs } = ACCEPTANCE_PROFILE_LIMITS
    if (
      typeof value.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < minTimeoutMs ||
      value.timeoutMs > maxTimeoutMs
    ) {
      problem(
        "acceptance_profile_timeout_invalid",
        at,
        `timeoutMs must be an integer from ${minTimeoutMs} to ${maxTimeoutMs}`
      )
    } else {
      timeoutMs = value.timeoutMs
    }
  }

  if (problems.length > before || !report) return null
  return { command, cwd, report, requiredTests, timeoutMs }
}

/**
 * Validate an `acceptanceProfiles` value already in memory: the file's block
 * (through `parseWorkspaceAcceptanceProfiles`) or a project override. `pointer`
 * is where the value sits in its own document, so every problem is
 * addressable there. `undefined` declares none.
 */
export function parseAcceptanceProfilesValue(
  value: unknown,
  pointer = jsonPointer("", ACCEPTANCE_PROFILES_KEY)
): AcceptanceProfilesParseResult {
  if (value === undefined) return { ok: true, profiles: {} }
  if (!isRecord(value)) {
    return {
      ok: false,
      problems: [
        {
          code: "acceptance_profiles_not_object",
          pointer,
          message: "acceptanceProfiles must be an object keyed by profile id",
        },
      ],
    }
  }
  const problems: AcceptanceProfileProblem[] = []
  const ids = Object.keys(value)
  if (ids.length > ACCEPTANCE_PROFILE_LIMITS.maxProfiles) {
    problems.push({
      code: "acceptance_profiles_too_many",
      pointer,
      message: `at most ${ACCEPTANCE_PROFILE_LIMITS.maxProfiles} acceptance profiles`,
    })
  }
  const profiles: WorkspaceAcceptanceProfiles = {}
  for (const id of ids) {
    const at = jsonPointer(pointer, id)
    if (!ACCEPTANCE_PROFILE_ID.test(id)) {
      problems.push({
        code: "acceptance_profile_id_invalid",
        pointer: at,
        message: "a profile id is 1-64 letters, digits, `.`, `_` or `-`, starting alphanumeric",
      })
      continue
    }
    const profile = acceptanceProfile(value[id], at, problems)
    if (profile) profiles[id] = profile
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, profiles }
}

/** Every repeated key under `node`, which `JSON.parse` would resolve silently. */
function duplicateKeyProblems(node: Node, pointer: string, problems: AcceptanceProfileProblem[]) {
  if (node.type === "object") {
    const seen = new Set<string>()
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? []
      if (!keyNode) continue
      const key = String(keyNode.value)
      const at = jsonPointer(pointer, key)
      if (seen.has(key)) {
        problems.push({
          code: "acceptance_profile_key_duplicate",
          pointer: at,
          message: `duplicate key "${key}": JSON readers disagree on which one wins`,
        })
      }
      seen.add(key)
      if (valueNode) duplicateKeyProblems(valueNode, at, problems)
    }
  } else if (node.type === "array") {
    ;(node.children ?? []).forEach((child, index) =>
      duplicateKeyProblems(child, jsonPointer(pointer, index), problems)
    )
  }
}

/**
 * The `acceptanceProfiles` block of a `.cognia/workspace.json` text: `{}` when
 * the file declares none. Validates the block only; `readWorkspaceAcceptanceProfiles`
 * also requires the rest of the file to be valid.
 */
export function parseWorkspaceAcceptanceProfiles(source: string): AcceptanceProfilesParseResult {
  const errors: ParseError[] = []
  const root = parseTree(source, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  })
  if (errors.length > 0 || !root || root.type !== "object") {
    const [first] = errors
    return {
      ok: false,
      problems: [
        {
          code: "acceptance_profiles_document_invalid",
          pointer: "",
          message: first
            ? `workspace.json is not valid JSON: ${printParseErrorCode(first.error)} at offset ${first.offset}`
            : "workspace.json must be an object",
        },
      ],
    }
  }
  const pointer = jsonPointer("", ACCEPTANCE_PROFILES_KEY)
  const blocks = (root.children ?? []).filter(
    (property) => property.children?.[0]?.value === ACCEPTANCE_PROFILES_KEY
  )
  if (blocks.length === 0) return { ok: true, profiles: {} }
  if (blocks.length > 1) {
    return {
      ok: false,
      problems: [
        {
          code: "acceptance_profile_key_duplicate",
          pointer,
          message: `duplicate key "${ACCEPTANCE_PROFILES_KEY}": JSON readers disagree on which one wins`,
        },
      ],
    }
  }
  const valueNode = blocks[0].children?.[1]
  const duplicates: AcceptanceProfileProblem[] = []
  if (valueNode) duplicateKeyProblems(valueNode, pointer, duplicates)
  if (duplicates.length > 0) return { ok: false, problems: duplicates }
  return parseAcceptanceProfilesValue(valueNode ? getNodeValue(valueNode) : null, pointer)
}

/** An invalid `acceptanceProfiles` block, with every problem and its JSON pointer. */
export class AcceptanceProfilesConfigError extends WorkspaceConfigError {
  constructor(readonly acceptanceProblems: AcceptanceProfileProblem[]) {
    super(
      `acceptanceProfiles is invalid: ${acceptanceProblems
        .map((problem) => `${problem.code} at ${problem.pointer || "/"}`)
        .join(", ")}`,
      acceptanceProblems[0]?.pointer || jsonPointer("", ACCEPTANCE_PROFILES_KEY)
    )
    this.name = "AcceptanceProfilesConfigError"
  }
}

/**
 * The acceptance profiles `.cognia/workspace.json` at `root` declares: `{}`
 * when it declares none, null when there is no file. Router + Fusion only;
 * nothing on the existing workspace-config path calls this.
 *
 * The rest of the file must be valid too (`parseWorkspaceConfig` runs first
 * and throws its own `WorkspaceConfigError`): a broken file never half-applies,
 * and a command from a file the existing gate calls invalid would come from a
 * file nobody could approve. Read failures follow `readWorkspaceConfig`: a
 * missing file is null, anything else is a `WorkspaceConfigError`.
 */
export async function readWorkspaceAcceptanceProfiles(
  root: string,
  read: (root: string, relativePath: string, maxBytes: number) => Promise<string>
): Promise<WorkspaceAcceptanceProfiles | null> {
  let source: string
  try {
    source = await read(root, WORKSPACE_CONFIG_PATH, WORKSPACE_CONFIG_MAX_BYTES)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // The same "missing file" rule as `readWorkspaceConfig`.
    if (/not found|no such file|does not exist/i.test(message)) return null
    throw new WorkspaceConfigError(`Unable to read workspace.json: ${message}`)
  }
  parseWorkspaceConfig(source)
  const parsed = parseWorkspaceAcceptanceProfiles(source)
  if (!parsed.ok) throw new AcceptanceProfilesConfigError(parsed.problems)
  return parsed.profiles
}

export type AcceptanceProfileSource = "repository" | "project"

export interface MergedAcceptanceProfile {
  id: string
  profile: WorkspaceAcceptanceProfile
  source: AcceptanceProfileSource
}

export interface MergedAcceptanceProfiles {
  /** Every effective profile, sorted by id. */
  profiles: MergedAcceptanceProfile[]
  /**
   * Repository profiles the project replaces with a different definition.
   * "Local wins" is only a safe rule while the user can see where it applied.
   */
  overriddenProfiles: string[]
}

/**
 * The project override over the repository's profiles: local wins, per id,
 * exactly as `mergeWorkspaceConfig` resolves variables. Both sides as parsed
 * (`parseAcceptanceProfilesValue` / `readWorkspaceAcceptanceProfiles`).
 */
export function mergeAcceptanceProfiles(
  repository: WorkspaceAcceptanceProfiles,
  project: WorkspaceAcceptanceProfiles
): MergedAcceptanceProfiles {
  const has = (profiles: WorkspaceAcceptanceProfiles, id: string) =>
    Object.prototype.hasOwnProperty.call(profiles, id)
  const ids = [...new Set([...Object.keys(repository), ...Object.keys(project)])].sort()
  return {
    profiles: ids.map((id): MergedAcceptanceProfile =>
      has(project, id)
        ? { id, profile: project[id], source: "project" }
        : { id, profile: repository[id], source: "repository" }
    ),
    overriddenProfiles: ids.filter(
      (id) =>
        has(repository, id) &&
        has(project, id) &&
        JSON.stringify(repository[id]) !== JSON.stringify(project[id])
    ),
  }
}
