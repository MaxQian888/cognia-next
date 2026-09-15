/**
 * A repository's runtime-environment declaration, normalised (ADR-0182).
 *
 * Two files can declare one: the `environment` block of
 * `.cognia/workspace.json`, and a `devcontainer.json`
 * (`./devcontainer.ts`). Both parse into this one shape, so approval,
 * digesting and resolution never care which file a repository used.
 *
 * # What the digest covers
 *
 * Everything that changes what runs or what it can reach: the file and path,
 * the normalised image reference, env, lifecycle commands, forwarded ports,
 * the declared user and requested egress domains. Not the fields a file
 * carries that Cognia ignores (a devcontainer `name`, editor
 * `customizations`): editing those must not revoke an approval. Digesting the
 * normalised form rather than the text means reformatting and comments never
 * re-prompt either. RFC 8785, so the Host can store and compare it verbatim.
 *
 * # Problems are collected, not thrown
 *
 * A declaration usually fails for more than one reason at once, and the
 * approval panel shows them all; stopping at the first would turn fixing a
 * file into a loop of one error per save.
 */

import { sha256String } from "@/lib/ocr/hash"
import { canonicalizeJson } from "@/lib/plugin/character-pack/canonical-json"
import {
  ENVIRONMENT_SPEC_LIMITS,
  type CommandSpec,
  type DeclarationFile,
  type DeclaredUser,
  type DeclaredUserSource,
  type ForwardPort,
  type LifecycleCommands,
  type SingleCommandSpec,
} from "@/types/sandbox/environment-spec"

import { canonicalImageReference, type ImageReference } from "./image-reference"

export interface EnvironmentDeclaration {
  file: DeclarationFile
  /** Repository-relative path of the declaring file. */
  path: string
  image: ImageReference
  /**
   * Values may contain `${containerEnv:NAME}` or `${containerEnv:NAME:default}`,
   * expanded by `cognia-sandboxd` against the image's environment when a
   * process starts (ADR-0183). Every other variable form is refused at parse.
   */
  containerEnv: Record<string, string>
  lifecycleCommands: LifecycleCommands
  forwardPorts: ForwardPort[]
  user?: DeclaredUser
  /** Lowercased, unique, sorted. Only `.cognia/workspace.json` can request these. */
  egressDomains: string[]
}

export type DeclarationProblemCode =
  | "declaration_too_large"
  | "declaration_invalid_json"
  | "declaration_duplicate_key"
  | "declaration_not_object"
  | "declaration_image_missing"
  | "declaration_image_invalid"
  | "declaration_env_invalid"
  | "declaration_env_reserved"
  | "declaration_command_invalid"
  | "declaration_port_invalid"
  | "declaration_user_invalid"
  | "declaration_egress_domain_invalid"
  | "declaration_variable_unsupported"
  | "declaration_field_unknown"
  | "devcontainer_field_refused"
  | "devcontainer_build_requires_build_service"
  | "devcontainer_gpu_not_supported"

export interface DeclarationProblem {
  code: DeclarationProblemCode
  /** JSON-path-ish location, e.g. `postStartCommand.web`. */
  field: string
  detail?: Record<string, string | number>
}

/** A field that parsed but has no effect in a Cognia sandbox. Shown, never digested. */
export interface DeclarationNotice {
  code: "declaration_field_ignored"
  field: string
}

export type DeclarationParseResult =
  | { ok: true; declaration: EnvironmentDeclaration; notices: DeclarationNotice[] }
  | { ok: false; problems: DeclarationProblem[]; notices: DeclarationNotice[] }

const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).length
}

export function isValidEnvName(name: string): boolean {
  return name.length <= 256 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** POSIX-portable user names, as `spec.rs` accepts them. */
export function isValidUserName(name: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(name)
}

/** Parallel command names, as `spec.rs` accepts them. */
export function isValidCommandName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name)
}

/**
 * Normalises env entries in order (later entries win). `value === null`
 * removes an earlier entry, as devcontainer `remoteEnv` allows.
 */
export function normalizeEnv(
  entries: ReadonlyArray<readonly [name: string, value: unknown, field: string]>,
  problems: DeclarationProblem[]
): Record<string, string> {
  const env = new Map<string, string>()
  for (const [name, value, field] of entries) {
    if (!isValidEnvName(name)) {
      problems.push({ code: "declaration_env_invalid", field, detail: { reason: "name" } })
      continue
    }
    if (name.startsWith(ENVIRONMENT_SPEC_LIMITS.reservedEnvPrefix)) {
      problems.push({ code: "declaration_env_reserved", field })
      continue
    }
    if (value === null) {
      env.delete(name)
      continue
    }
    if (typeof value !== "string") {
      problems.push({ code: "declaration_env_invalid", field, detail: { reason: "type" } })
      continue
    }
    if (byteLength(value) > ENVIRONMENT_SPEC_LIMITS.maxEnvValueBytes || value.includes("\0")) {
      problems.push({ code: "declaration_env_invalid", field, detail: { reason: "value" } })
      continue
    }
    env.set(name, value)
  }
  if (env.size > ENVIRONMENT_SPEC_LIMITS.maxEnvEntries) {
    problems.push({
      code: "declaration_env_invalid",
      field: "containerEnv",
      detail: { reason: "count", limit: ENVIRONMENT_SPEC_LIMITS.maxEnvEntries },
    })
  }
  return Object.fromEntries([...env.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * A lifecycle command in the devcontainer shapes: a string runs through a
 * shell, an array execs directly, an object runs its named entries in
 * parallel. `transform` substitutes variables in every string it sees.
 */
export function normalizeCommand(
  value: unknown,
  field: string,
  problems: DeclarationProblem[],
  transform: (text: string, field: string) => string | undefined
): CommandSpec | undefined {
  const single = (entry: unknown, entryField: string): SingleCommandSpec | undefined => {
    if (typeof entry === "string") {
      const command = transform(entry, entryField)
      if (command === undefined) return undefined
      if (
        !command.trim() ||
        byteLength(command) > ENVIRONMENT_SPEC_LIMITS.maxShellCommandBytes ||
        command.includes("\0")
      ) {
        problems.push({ code: "declaration_command_invalid", field: entryField })
        return undefined
      }
      return { kind: "shell", command }
    }
    if (Array.isArray(entry)) {
      if (
        entry.length === 0 ||
        entry.length > ENVIRONMENT_SPEC_LIMITS.maxArgvEntries ||
        !entry.every((arg) => typeof arg === "string")
      ) {
        problems.push({ code: "declaration_command_invalid", field: entryField })
        return undefined
      }
      const argv: string[] = []
      for (const [index, arg] of (entry as string[]).entries()) {
        const substituted = transform(arg, `${entryField}[${index}]`)
        if (substituted === undefined) return undefined
        argv.push(substituted)
      }
      if (
        !argv[0]!.trim() ||
        argv.some(
          (arg) => byteLength(arg) > ENVIRONMENT_SPEC_LIMITS.maxArgvEntryBytes || arg.includes("\0")
        )
      ) {
        problems.push({ code: "declaration_command_invalid", field: entryField })
        return undefined
      }
      return { kind: "argv", argv }
    }
    problems.push({ code: "declaration_command_invalid", field: entryField })
    return undefined
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0 || entries.length > ENVIRONMENT_SPEC_LIMITS.maxParallelCommands) {
      problems.push({ code: "declaration_command_invalid", field, detail: { reason: "count" } })
      return undefined
    }
    const commands: Record<string, SingleCommandSpec> = {}
    let failed = false
    for (const [name, entry] of entries) {
      const entryField = `${field}.${name}`
      if (!isValidCommandName(name)) {
        problems.push({ code: "declaration_command_invalid", field: entryField })
        failed = true
        continue
      }
      const command = single(entry, entryField)
      if (!command) failed = true
      else commands[name] = command
    }
    return failed ? undefined : { kind: "parallel", commands }
  }
  return single(value, field)
}

/** Forwarded ports: integers or numeric strings, unique, at most 64. */
export function normalizePorts(
  value: unknown,
  field: string,
  problems: DeclarationProblem[],
  labels: ReadonlyMap<number, string> = new Map()
): ForwardPort[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push({ code: "declaration_port_invalid", field })
    return []
  }
  if (value.length > ENVIRONMENT_SPEC_LIMITS.maxForwardPorts) {
    problems.push({
      code: "declaration_port_invalid",
      field,
      detail: { reason: "count", limit: ENVIRONMENT_SPEC_LIMITS.maxForwardPorts },
    })
    return []
  }
  const ports: ForwardPort[] = []
  const seen = new Set<number>()
  for (const [index, raw] of value.entries()) {
    const entryField = `${field}[${index}]`
    const port =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw)
          ? Number(raw)
          : NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      // `"db:5432"` names a compose service, which Cognia does not run.
      problems.push({ code: "declaration_port_invalid", field: entryField })
      continue
    }
    if (seen.has(port)) {
      problems.push({
        code: "declaration_port_invalid",
        field: entryField,
        detail: { reason: "duplicate" },
      })
      continue
    }
    seen.add(port)
    const label = labels.get(port)
    ports.push(label ? { port, label } : { port })
  }
  return ports
}

/** A user given as a name or a numeric uid. `user:group` is refused, not truncated. */
export function normalizeUser(
  value: unknown,
  from: DeclaredUserSource,
  field: string,
  problems: DeclarationProblem[]
): DeclaredUser | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") {
    const text = value.trim()
    if (/^\d+$/.test(text) && Number(text) <= 2 ** 31 - 1) return { uid: Number(text), from }
    if (isValidUserName(text)) return { name: text, from }
  } else if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2 ** 31 - 1
  ) {
    return { uid: value, from }
  }
  problems.push({ code: "declaration_user_invalid", field })
  return undefined
}

/**
 * Requested egress domains: exact DNS names or `*.` wildcards over one, never
 * IP literals — internal addresses are baseline exceptions, not something a
 * repository can ask for. Mirrors `spec.rs::is_valid_domain_pattern`.
 */
export function isValidEgressDomainPattern(pattern: string): boolean {
  const host = pattern.startsWith("*.") ? pattern.slice(2) : pattern
  if (!host || !host.includes(".") || host.endsWith(".") || host.length > 253) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false
  return host
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9-]+$/.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-")
    )
}

export function normalizeEgressDomains(
  value: unknown,
  field: string,
  problems: DeclarationProblem[]
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push({ code: "declaration_egress_domain_invalid", field })
    return []
  }
  const domains = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "string" || !isValidEgressDomainPattern(raw.trim())) {
      problems.push({ code: "declaration_egress_domain_invalid", field: `${field}[${index}]` })
      continue
    }
    domains.add(raw.trim().toLowerCase())
  }
  if (domains.size > ENVIRONMENT_SPEC_LIMITS.maxEgressDomains) {
    problems.push({
      code: "declaration_egress_domain_invalid",
      field,
      detail: { reason: "count", limit: ENVIRONMENT_SPEC_LIMITS.maxEgressDomains },
    })
    return []
  }
  return [...domains].sort()
}

/** SHA-256 (lowercase hex) over the RFC 8785 form of the digest-relevant fields. See the header. */
export async function environmentDeclarationDigest(
  declaration: EnvironmentDeclaration
): Promise<string> {
  return sha256String(
    canonicalizeJson({
      version: 1,
      file: declaration.file,
      path: declaration.path,
      image: canonicalImageReference(declaration.image),
      containerEnv: declaration.containerEnv,
      lifecycleCommands: declaration.lifecycleCommands,
      forwardPorts: declaration.forwardPorts,
      ...(declaration.user ? { user: declaration.user } : {}),
      egressDomains: declaration.egressDomains,
    })
  )
}
