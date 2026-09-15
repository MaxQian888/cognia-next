/**
 * `devcontainer.json`, read closed-world (ADR-0182).
 *
 * Cognia runs a devcontainer's image with its env, lifecycle commands,
 * forwarded ports and user — and nothing else. Every top-level key falls in
 * exactly one bucket below; a key in none of them is refused
 * (`declaration_field_unknown`) rather than skipped, because a field silently
 * doing nothing is how a repository ends up believing it configured
 * something it did not.
 *
 * - **Honored** — `image`, `containerEnv`, `remoteEnv`, the five lifecycle
 *   commands, `forwardPorts` (labels from `portsAttributes`), `remoteUser`,
 *   `containerUser`.
 * - **Ignored with a notice** — fields with no effect in a Cognia sandbox:
 *   editor `customizations`, `name`, `shutdownAction`, `overrideCommand`
 *   (the supervisor is PID 1 regardless), `init`, `waitFor`, `userEnvProbe`,
 *   `updateRemoteUserUID`, `otherPortsAttributes`, `workspaceFolder` (the
 *   workspace is always `/workspace`), `hostRequirements` without a GPU (the
 *   catalog's size classes decide resources).
 * - **Refused** — anything that reaches past the container or into the host:
 *   `privileged`, `capAdd`, `securityOpt`, `runArgs`, `mounts`,
 *   `workspaceMount`, `initializeCommand` (runs on the host), `appPort`, and
 *   compose (`dockerComposeFile`, `service`, `runServices`).
 * - **Dormant** — `build`, `dockerFile`, `context`, `features`,
 *   `overrideFeatureInstallOrder` need the environment build service
 *   (ADR-0186), which does not exist yet: refused with
 *   `devcontainer_build_requires_build_service`, labelled in the type
 *   (`DEVCONTAINER_DORMANT_FIELDS`), the UI and the test.
 *
 * # Variables
 *
 * `${containerWorkspaceFolder}` and `${containerWorkspaceFolderBasename}` are
 * substituted here (`/workspace`, `workspace`). `${containerEnv:NAME}` is kept
 * literally in `remoteEnv` values, where the spec allows it, and expanded by
 * the sandbox supervisor. Everything else — `${localEnv:…}` and
 * `${localWorkspaceFolder}` would copy the reading machine's environment or
 * paths into a declaration other people approve — is refused.
 */

import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser"

import { SANDBOX_WORKSPACE_FOLDER, type LifecycleCommands } from "@/types/sandbox/environment-spec"

import {
  normalizeCommand,
  normalizeEnv,
  normalizePorts,
  normalizeUser,
  type DeclarationNotice,
  type DeclarationParseResult,
  type DeclarationProblem,
} from "./environment-declaration"
import { ImageReferenceError, parseImageReference, type ImageReference } from "./image-reference"

export const DEVCONTAINER_MAX_BYTES = 256 * 1024

/** Where a repository's devcontainer is looked for, in order. */
export const DEVCONTAINER_CANDIDATE_PATHS = [
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
] as const

const LIFECYCLE_FIELDS = {
  onCreateCommand: "onCreate",
  updateContentCommand: "updateContent",
  postCreateCommand: "postCreate",
  postStartCommand: "postStart",
  postAttachCommand: "postAttach",
} as const satisfies Record<string, keyof LifecycleCommands>

export const DEVCONTAINER_HONORED_FIELDS = [
  "image",
  "containerEnv",
  "remoteEnv",
  ...(Object.keys(LIFECYCLE_FIELDS) as Array<keyof typeof LIFECYCLE_FIELDS>),
  "forwardPorts",
  "portsAttributes",
  "remoteUser",
  "containerUser",
] as const

export const DEVCONTAINER_IGNORED_FIELDS = [
  "$schema",
  "name",
  "customizations",
  "shutdownAction",
  "overrideCommand",
  "init",
  "waitFor",
  "userEnvProbe",
  "updateRemoteUserUID",
  "otherPortsAttributes",
  "workspaceFolder",
  "hostRequirements",
] as const

export const DEVCONTAINER_REFUSED_FIELDS = [
  "privileged",
  "capAdd",
  "securityOpt",
  "runArgs",
  "mounts",
  "workspaceMount",
  "initializeCommand",
  "appPort",
  "dockerComposeFile",
  "service",
  "runServices",
] as const

/**
 * Dormant until the environment build service (ADR-0186) ships. A declaration
 * using any of these is refused with `devcontainer_build_requires_build_service`;
 * the Runtime environment panel labels it as "needs image builds", and
 * `devcontainer.test.ts` pins the refusal so enabling builds has to flip all three.
 */
export const DEVCONTAINER_DORMANT_FIELDS = [
  "build",
  "dockerFile",
  "context",
  "features",
  "overrideFeatureInstallOrder",
] as const

const HONORED = new Set<string>(DEVCONTAINER_HONORED_FIELDS)
const IGNORED = new Set<string>(DEVCONTAINER_IGNORED_FIELDS)
const REFUSED = new Set<string>(DEVCONTAINER_REFUSED_FIELDS)
const DORMANT = new Set<string>(DEVCONTAINER_DORMANT_FIELDS)

const VARIABLE = /\$\{([^}]*)\}/g
const CONTAINER_ENV_VARIABLE = /^containerEnv:[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?$/

/**
 * Parses devcontainer text. `path` is the repository-relative location, which
 * becomes part of the declaration (and its digest).
 */
export function parseDevcontainer(text: string, path: string): DeclarationParseResult {
  const problems: DeclarationProblem[] = []
  const notices: DeclarationNotice[] = []
  const fail = (): DeclarationParseResult => ({ ok: false, problems, notices })

  if (new TextEncoder().encode(text).length > DEVCONTAINER_MAX_BYTES) {
    problems.push({
      code: "declaration_too_large",
      field: path,
      detail: { limit: DEVCONTAINER_MAX_BYTES },
    })
    return fail()
  }

  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !tree) {
    const first = errors[0]
    problems.push({
      code: "declaration_invalid_json",
      field: path,
      detail: first
        ? { error: printParseErrorCode(first.error), ...lineAndColumn(text, first.offset) }
        : { error: "empty" },
    })
    return fail()
  }
  if (tree.type !== "object") {
    problems.push({ code: "declaration_not_object", field: path })
    return fail()
  }
  const duplicate = findDuplicateKey(tree)
  if (duplicate) {
    problems.push({ code: "declaration_duplicate_key", field: duplicate })
    return fail()
  }

  const row = getNodeValue(tree) as Record<string, unknown>
  for (const key of Object.keys(row)) {
    if (HONORED.has(key)) continue
    if (DORMANT.has(key)) {
      problems.push({ code: "devcontainer_build_requires_build_service", field: key })
    } else if (REFUSED.has(key)) {
      problems.push({ code: "devcontainer_field_refused", field: key })
    } else if (key === "hostRequirements" && requestsGpu(row.hostRequirements)) {
      problems.push({ code: "devcontainer_gpu_not_supported", field: "hostRequirements.gpu" })
    } else if (IGNORED.has(key)) {
      notices.push({ code: "declaration_field_ignored", field: key })
    } else {
      problems.push({ code: "declaration_field_unknown", field: key })
    }
  }

  const substitute = (allowContainerEnv: boolean) => (value: string, field: string) => {
    let unsupported: string | undefined
    const result = value.replace(VARIABLE, (match, name: string) => {
      if (name === "containerWorkspaceFolder") return SANDBOX_WORKSPACE_FOLDER
      if (name === "containerWorkspaceFolderBasename") {
        return SANDBOX_WORKSPACE_FOLDER.split("/").pop() ?? ""
      }
      if (allowContainerEnv && CONTAINER_ENV_VARIABLE.test(name)) return match
      unsupported ??= name
      return match
    })
    if (unsupported !== undefined) {
      problems.push({
        code: "declaration_variable_unsupported",
        field,
        detail: { variable: unsupported },
      })
      return undefined
    }
    return result
  }

  let image: ImageReference | undefined
  const hasDormantBuild = Object.keys(row).some((key) => DORMANT.has(key))
  if (row.image === undefined) {
    // A build-only devcontainer is already refused as dormant; do not pile on.
    if (!hasDormantBuild) problems.push({ code: "declaration_image_missing", field: "image" })
  } else if (typeof row.image !== "string") {
    problems.push({ code: "declaration_image_invalid", field: "image" })
  } else {
    const text = substitute(false)(row.image, "image")
    if (text !== undefined) {
      try {
        image = parseImageReference(text)
      } catch (cause) {
        problems.push({
          code: "declaration_image_invalid",
          field: "image",
          detail: { reason: cause instanceof ImageReferenceError ? cause.kind : "invalid" },
        })
      }
    }
  }

  const envEntries: Array<readonly [string, unknown, string]> = []
  for (const [key, allowContainerEnv] of [
    ["containerEnv", false],
    ["remoteEnv", true],
  ] as const) {
    const value = row[key]
    if (value === undefined) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push({ code: "declaration_env_invalid", field: key, detail: { reason: "type" } })
      continue
    }
    for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
      const field = `${key}.${name}`
      if (typeof raw === "string") {
        const substituted = substitute(allowContainerEnv)(raw, field)
        if (substituted !== undefined) envEntries.push([name, substituted, field])
      } else if (raw === null && key === "remoteEnv") {
        envEntries.push([name, null, field])
      } else {
        problems.push({ code: "declaration_env_invalid", field, detail: { reason: "type" } })
      }
    }
  }
  const containerEnv = normalizeEnv(envEntries, problems)

  const lifecycleCommands: LifecycleCommands = {}
  for (const [key, name] of Object.entries(LIFECYCLE_FIELDS)) {
    if (row[key] === undefined) continue
    const command = normalizeCommand(row[key], key, problems, substitute(false))
    if (command) lifecycleCommands[name] = command
  }

  const forwardPorts = normalizePorts(
    row.forwardPorts,
    "forwardPorts",
    problems,
    portLabels(row.portsAttributes, problems)
  )

  // Agents are the "remote" tools, so remoteUser decides; containerUser is
  // still validated so a broken value is reported rather than hidden.
  const remoteUser = normalizeUser(row.remoteUser, "remoteUser", "remoteUser", problems)
  const containerUser = normalizeUser(row.containerUser, "containerUser", "containerUser", problems)
  const user = row.remoteUser !== undefined ? remoteUser : containerUser

  if (problems.length > 0 || !image) return fail()
  return {
    ok: true,
    declaration: {
      file: "devcontainer",
      path,
      image,
      containerEnv,
      lifecycleCommands,
      forwardPorts,
      ...(user ? { user } : {}),
      egressDomains: [],
    },
    notices,
  }
}

function requestsGpu(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const gpu = (value as Record<string, unknown>).gpu
  // `"optional"` runs without one, so it is merely ignored.
  return gpu === true || (typeof gpu === "object" && gpu !== null)
}

/** Labels for exact-port keys of `portsAttributes`; ranges and patterns carry nothing Cognia uses. */
function portLabels(value: unknown, problems: DeclarationProblem[]): Map<number, string> {
  const labels = new Map<number, string>()
  if (value === undefined) return labels
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push({ code: "declaration_port_invalid", field: "portsAttributes" })
    return labels
  }
  for (const [key, attributes] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !attributes || typeof attributes !== "object") continue
    const label = (attributes as Record<string, unknown>).label
    if (typeof label !== "string") continue
    const trimmed = label.trim()
    if (!trimmed || [...trimmed].length > 128) {
      problems.push({ code: "declaration_port_invalid", field: `portsAttributes.${key}.label` })
      continue
    }
    labels.set(Number(key), trimmed)
  }
  return labels
}

/** The first object in `node` that names a key twice, as a dotted path. */
function findDuplicateKey(node: Node, path: string[] = []): string | undefined {
  if (node.type === "object") {
    const seen = new Set<string>()
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? []
      const key = String(keyNode?.value)
      if (seen.has(key)) return [...path, key].join(".")
      seen.add(key)
      if (valueNode) {
        const nested = findDuplicateKey(valueNode, [...path, key])
        if (nested) return nested
      }
    }
  } else if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      const nested = findDuplicateKey(child, [...path, `[${index}]`])
      if (nested) return nested
    }
  }
  return undefined
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset)
  const line = before.split("\n").length
  return { line, column: offset - before.lastIndexOf("\n") }
}
