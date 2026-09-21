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
 * - **Build inputs** — Dockerfile builds and Features are validated here and
 *   executed by the Host's pinned official devcontainer CLI after approval.
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

import type { CommandSpec, LifecycleCommands } from "@/types/sandbox/environment-spec"

import {
  normalizeCommand,
  normalizeEnv,
  normalizeImage,
  normalizePorts,
  normalizeUser,
  normalizeWorkspaceFolder,
  substituteDeclarationVariables,
  type DeclarationNotice,
  type DeclarationParseResult,
  type DeclarationProblem,
  type EnvironmentDeclaration,
} from "./environment-declaration"
import type { ImageReference } from "./image-reference"

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
  "workspaceFolder",
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

/** Inputs executed by the configured official devcontainer build service. */
export const DEVCONTAINER_BUILD_FIELDS = [
  "build",
  "dockerFile",
  "context",
  "features",
  "overrideFeatureInstallOrder",
] as const

const HONORED = new Set<string>(DEVCONTAINER_HONORED_FIELDS)
const IGNORED = new Set<string>(DEVCONTAINER_IGNORED_FIELDS)
const REFUSED = new Set<string>(DEVCONTAINER_REFUSED_FIELDS)
const BUILD_FIELDS = new Set<string>(DEVCONTAINER_BUILD_FIELDS)

/**
 * Parses devcontainer text. `path` is the repository-relative location, which
 * becomes part of the declaration (and its digest).
 */
export function parseDevcontainer(
  text: string,
  path: string,
  runtimeOnly = false
): DeclarationParseResult {
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
    if (BUILD_FIELDS.has(key)) continue
    if (REFUSED.has(key)) {
      problems.push({ code: "devcontainer_field_refused", field: key })
    } else if (key === "hostRequirements" && requestsGpu(row.hostRequirements)) {
      problems.push({ code: "devcontainer_gpu_not_supported", field: "hostRequirements.gpu" })
    } else if (IGNORED.has(key)) {
      notices.push({ code: "declaration_field_ignored", field: key })
    } else {
      problems.push({ code: "declaration_field_unknown", field: key })
    }
  }

  const substitute = (allowContainerEnv: boolean) => (value: string, field: string) =>
    substituteDeclarationVariables(value, field, problems, allowContainerEnv)

  let image: ImageReference | undefined
  const build = normalizeBuild(row, path, problems)
  if (runtimeOnly) {
    // The build record separately attests its Docker image id. Runtime
    // metadata must never turn that configuration id into a registry name.
  } else if (row.image === undefined) {
    if (!build) problems.push({ code: "declaration_image_missing", field: "image" })
  } else {
    image = normalizeImage(row.image, "image", problems)
  }

  const envEntries: Array<readonly [string, unknown, string]> = []
  const remoteEntries: Array<readonly [string, unknown, string]> = []
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
      const entries = key === "remoteEnv" ? remoteEntries : envEntries
      const field = `${key}.${name}`
      if (typeof raw === "string") {
        const substituted = substitute(allowContainerEnv)(raw, field)
        if (substituted !== undefined) entries.push([name, substituted, field])
      } else if (raw === null && key === "remoteEnv") {
        entries.push([name, null, field])
      } else {
        problems.push({ code: "declaration_env_invalid", field, detail: { reason: "type" } })
      }
    }
  }
  const containerEnv = normalizeEnv(envEntries, problems)
  const remoteEnv = normalizeEnv(remoteEntries, problems, true)
  const workspaceFolder = normalizeWorkspaceFolder(row.workspaceFolder, "workspaceFolder", problems)

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

  if (problems.length > 0 || (!runtimeOnly && !image && !build)) return fail()
  return {
    ok: true,
    declaration: {
      file: "devcontainer",
      path,
      ...(image ? { image } : {}),
      ...(build ? { build } : {}),
      containerEnv,
      ...(Object.keys(remoteEnv).length ? { remoteEnv } : {}),
      ...(workspaceFolder !== undefined ? { workspaceFolder } : {}),
      lifecycleCommands,
      forwardPorts,
      ...(user ? { user } : {}),
      egressDomains: [],
    },
    notices,
  }
}

/** Normalize official CLI merged image metadata with the same refusal rules. */
export function builtEnvironmentDeclaration(
  runtimeConfiguration: unknown,
  original: EnvironmentDeclaration
): DeclarationParseResult {
  if (
    !runtimeConfiguration ||
    typeof runtimeConfiguration !== "object" ||
    Array.isArray(runtimeConfiguration)
  ) {
    return {
      ok: false,
      problems: [{ code: "declaration_not_object", field: "runtimeConfiguration" }],
      notices: [],
    }
  }
  const row = { ...(runtimeConfiguration as Record<string, unknown>) }
  // Official merge emits false/default entries even when no image asks for
  // host privileges. Remove only these no-op values, never positive requests.
  if (row.privileged === false) delete row.privileged
  for (const key of ["capAdd", "securityOpt", "mounts", "entrypoints"]) {
    if (Array.isArray(row[key]) && row[key].length === 0) delete row[key]
  }
  const commands: LifecycleCommands = {}
  const problems: DeclarationProblem[] = []
  for (const [field, phase] of Object.entries(LIFECYCLE_FIELDS)) {
    const plural = `${field}s`
    if (row[plural] === undefined) continue
    const values = row[plural]
    delete row[plural]
    if (row[field] !== undefined || !Array.isArray(values) || values.length > 255) {
      problems.push({ code: "declaration_command_invalid", field: plural })
      continue
    }
    const sequence: CommandSpec[] = []
    let nodes = 1
    for (const [index, value] of values.entries()) {
      const command = normalizeCommand(value, `${plural}[${index}]`, problems, (text, field) =>
        substituteDeclarationVariables(text, field, problems, false)
      )
      if (!command) continue
      nodes += command.kind === "parallel" ? 1 + Object.keys(command.commands).length : 1
      sequence.push(command)
    }
    if (nodes > 256) problems.push({ code: "declaration_command_invalid", field: plural })
    else if (sequence.length) commands[phase] = { kind: "sequence", commands: sequence }
  }
  if (problems.length) return { ok: false, problems, notices: [] }
  const parsed = parseDevcontainer(JSON.stringify(row), original.path, true)
  if (!parsed.ok) return parsed
  return {
    ...parsed,
    declaration: {
      ...parsed.declaration,
      file: original.file,
      path: original.path,
      ...(original.image ? { image: original.image } : {}),
      ...(original.build ? { build: original.build } : {}),
      ...(original.workspaceFolder ? { workspaceFolder: original.workspaceFolder } : {}),
      ...(original.lifecycleTimeoutMs !== undefined
        ? { lifecycleTimeoutMs: original.lifecycleTimeoutMs }
        : {}),
      lifecycleCommands: { ...parsed.declaration.lifecycleCommands, ...commands },
      egressDomains: original.egressDomains,
    },
  }
}

/** Build paths are relative to the declaration and must stay inside the checkout. */
function normalizeBuild(
  row: Record<string, unknown>,
  path: string,
  problems: DeclarationProblem[]
): Record<string, unknown> | undefined {
  const fields = Object.keys(row).filter((key) => BUILD_FIELDS.has(key))
  if (!fields.length) return undefined
  const invalid = (field: string) => problems.push({ code: "declaration_build_invalid", field })
  const scalar = (value: unknown) =>
    typeof value === "string" &&
    value.length <= 8192 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.includes("${")
  const nonempty = (value: unknown) => scalar(value) && value !== ""
  const localPath = (value: unknown, field: string) => {
    if (
      !nonempty(value) ||
      typeof value !== "string" ||
      value.startsWith("/") ||
      value.includes("\\") ||
      /^[A-Za-z]:/.test(value)
    ) {
      invalid(field)
      return
    }
    const segments = path.split("/").slice(0, -1)
    for (const part of value.split("/")) {
      if (part === "..") {
        if (!segments.length) {
          invalid(field)
          return
        }
        segments.pop()
      } else if (part !== "." && part !== "") segments.push(part)
    }
  }
  if (row.build !== undefined) {
    if (!row.build || typeof row.build !== "object" || Array.isArray(row.build)) invalid("build")
    else {
      const build = row.build as Record<string, unknown>
      if (row.dockerFile !== undefined || row.context !== undefined || row.image !== undefined)
        invalid("build")
      if (build.dockerfile === undefined) invalid("build.dockerfile")
      for (const [key, value] of Object.entries(build)) {
        if (key === "dockerfile" || key === "context") localPath(value, `build.${key}`)
        else if (key === "target") {
          if (!nonempty(value)) invalid(`build.${key}`)
        } else if (key === "args") {
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.values(value).some((arg) => !scalar(arg))
          )
            invalid("build.args")
        } else if (key === "cacheFrom") {
          if (!(nonempty(value) || (Array.isArray(value) && value.every(nonempty))))
            invalid("build.cacheFrom")
        } else invalid(`build.${key}`)
      }
    }
  }
  if (row.dockerFile !== undefined) {
    localPath(row.dockerFile, "dockerFile")
    if (row.image !== undefined) invalid("dockerFile")
  }
  if (row.context !== undefined) {
    localPath(row.context, "context")
    if (row.dockerFile === undefined) invalid("context")
  }
  if (row.features !== undefined) {
    if (!row.features || typeof row.features !== "object" || Array.isArray(row.features))
      invalid("features")
    else
      for (const [feature, options] of Object.entries(row.features)) {
        if (!nonempty(feature)) invalid(`features.${feature}`)
        if (feature.startsWith(".")) localPath(feature, `features.${feature}`)
        if (
          typeof options !== "boolean" &&
          (!options ||
            typeof options !== "object" ||
            Array.isArray(options) ||
            Object.values(options).some(
              (v) =>
                !(
                  typeof v === "boolean" ||
                  (typeof v === "number" && Number.isFinite(v)) ||
                  scalar(v)
                )
            ))
        )
          invalid(`features.${feature}`)
      }
  }
  if (
    row.overrideFeatureInstallOrder !== undefined &&
    (!Array.isArray(row.overrideFeatureInstallOrder) ||
      !row.overrideFeatureInstallOrder.every(nonempty))
  )
    invalid("overrideFeatureInstallOrder")
  if (row.image === undefined && row.build === undefined && row.dockerFile === undefined)
    invalid("build")
  return Object.fromEntries(fields.map((key) => [key, row[key]]))
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
