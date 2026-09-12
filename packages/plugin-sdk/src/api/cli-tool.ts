/** Portable declarative CLI-tool authoring and preview helpers. */

import type {
  PluginCliArgvToken,
  PluginCliCwdPolicy,
  PluginCliOutputParse,
} from "@/types/plugin/plugin-cli-tool"

export { defineCliTool } from "../define/define-cli-tool"
export type {
  PluginCliArgvToken,
  PluginCliBinaryRef,
  PluginCliCwdPolicy,
  PluginCliOutputParse,
  PluginCliToolDef,
} from "@/types/plugin/plugin-cli-tool"

export class CliTemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliTemplateError"
  }
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  )
}

function renderValue(name: string, value: unknown, eachPrefixedBy?: string): string[] {
  if (Array.isArray(value)) {
    const output: string[] = []
    for (const element of value) {
      if (typeof element === "object" && element !== null) {
        throw new CliTemplateError(`argv param "${name}" array elements must be scalars`)
      }
      if (eachPrefixedBy !== undefined) output.push(eachPrefixedBy)
      output.push(String(element))
    }
    return output
  }
  if (value === true) return eachPrefixedBy !== undefined ? [eachPrefixedBy] : ["true"]
  if (typeof value === "object" && value !== null) {
    throw new CliTemplateError(`argv param "${name}" must be a scalar or array, got object`)
  }
  const rendered = String(value)
  return eachPrefixedBy !== undefined ? [eachPrefixedBy, rendered] : [rendered]
}

export function buildArgv(
  tokens: readonly PluginCliArgvToken[],
  params: Record<string, unknown>
): string[] {
  const argv: string[] = []
  for (const token of tokens) {
    if ("literal" in token && typeof token.literal === "string") {
      argv.push(token.literal)
      continue
    }
    if (!("param" in token) || typeof token.param !== "string") {
      throw new CliTemplateError("argv token must be { literal } or { param }")
    }
    const value = params[token.param]
    if (isEmpty(value)) {
      if (token.omitWhenEmpty) continue
      throw new CliTemplateError(`missing required value for argv param "${token.param}"`)
    }
    argv.push(...renderValue(token.param, value, token.eachPrefixedBy))
  }
  return argv
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "")
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const normalizedChild = normalizePath(child).toLowerCase()
  const normalizedParent = normalizePath(parent).toLowerCase()
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)
}

export interface CwdContext {
  pluginPath: string
  workspaceRoot: string | undefined
}

// Protected credential paths — mirror of `sidecar/builtin-tools/confinement.mjs`
// `isSecretPath` (itself a mirror of `src-tauri/src/sandbox/protected.rs`).
// The three enforcement points are deliberately separate processes; the DATA
// must not drift — keep segment sets in union with both.
const CLI_PROTECTED_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
  ".docker",
  ".npmrc",
  ".cognia",
  ".config/gcloud",
  ".config/cognia",
])

const CLI_PROTECTED_BASENAMES = new Set([
  ".git-credentials",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pypirc",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
])

// The last two segments of Rust's multi-segment rels ride this list too
// (`.local/share/cognia` → `share/cognia`, `AppData/{Local,Roaming}/cognia` →
// `local|cognia`, `Library/Application Support/cognia` →
// `application support/cognia`) — over-deny on an unrelated `share/cognia`
// is the safe direction.
const CLI_PROTECTED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [".config", "gh"],
  [".cargo", "credentials.toml"],
  ["share", "cognia"],
  ["local", "cognia"],
  ["roaming", "cognia"],
  ["application support", "cognia"],
]

function cliPathSegments(path: string): string[] {
  return normalizePath(path).toLowerCase().split("/").filter(Boolean)
}

/**
 * True when `abs` is, sits under, or names a protected credential path.
 * Segment-based so it is drive/UNC/`~`-agnostic — the same rule the sidecar
 * applies to the built-in file tools.
 */
export function isProtectedCliPath(abs: string): boolean {
  const segs = cliPathSegments(abs)
  const base = segs[segs.length - 1]
  if (base && CLI_PROTECTED_BASENAMES.has(base)) return true
  for (let i = 0; i < segs.length; i++) {
    if (CLI_PROTECTED_SEGMENTS.has(segs[i]!)) return true
    if (i + 1 < segs.length && CLI_PROTECTED_SEGMENTS.has(`${segs[i]}/${segs[i + 1]}`)) {
      return true
    }
    for (const [a, b] of CLI_PROTECTED_PAIRS) {
      if (segs[i] === a && segs[i + 1] === b) return true
    }
  }
  return false
}

/**
 * Enforce `cliTools[].confinedPathParams`: each named parameter's value must
 * resolve inside `base` (the workspace root, or the plugin dir for
 * `cwd.kind === "plugin-dir"`). Rejects `..` segments, absolute paths outside
 * the base, and any path shaped like a credential store — even inside the
 * base, matching the built-in tools' hard deny. Absent/empty values pass;
 * arrays are checked elementwise. Lexical only (no realpath) — same caveat
 * as `resolveCwd`'s `param` policy.
 */
export function assertConfinedPathParams(
  params: Record<string, unknown>,
  names: readonly string[] | undefined,
  base: string | undefined
): void {
  if (!names || names.length === 0) return
  if (!base) {
    throw new CliTemplateError(
      "confinedPathParams requires a workspace root or plugin dir to confine against"
    )
  }
  for (const name of names) {
    const value = params[name]
    if (isEmpty(value)) continue
    const values = Array.isArray(value) ? value : [value]
    for (const element of values) {
      if (typeof element !== "string" || element.length === 0) {
        throw new CliTemplateError(`path param "${name}" must be a non-empty string`)
      }
      if (element.split(/[\\/]+/).some((segment) => segment === "..")) {
        throw new CliTemplateError(`path param "${name}" must not contain ".." segments`)
      }
      const resolved = isAbsolutePath(element)
        ? element
        : `${normalizePath(base)}/${element.replace(/\\/g, "/")}`
      if (!isInsideOrEqual(resolved, base)) {
        throw new CliTemplateError(`path param "${name}" must resolve inside ${base}`)
      }
      // Credential-shape check runs on the path RELATIVE to the base: a
      // confinement base may legitimately sit inside a protected dir (the
      // `plugin-dir` base lives under `~/.cognia`), and the base's own name
      // must not make every child path undenied… unreachable. Case-fold the
      // slice to match `isInsideOrEqual`'s lowercase compare.
      const normalizedBase = normalizePath(base).toLowerCase()
      const rel = normalizePath(resolved)
        .toLowerCase()
        .slice(normalizedBase.length + 1)
      if (rel && isProtectedCliPath(rel)) {
        throw new CliTemplateError(`path param "${name}" resolves into a protected credential path`)
      }
    }
  }
}

export function resolveCwd(
  policy: PluginCliCwdPolicy | undefined,
  params: Record<string, unknown>,
  context: CwdContext
): string | undefined {
  const kind = policy?.kind ?? "none"
  switch (kind) {
    case "none":
      return undefined
    case "plugin-dir":
      return context.pluginPath
    case "workspace":
      if (!context.workspaceRoot) {
        throw new CliTemplateError("cwd policy 'workspace' requires an open workspace")
      }
      return context.workspaceRoot
    case "param": {
      const paramName = (policy as { param?: string }).param
      const value = paramName ? params[paramName] : undefined
      if (typeof value !== "string" || value.length === 0) {
        throw new CliTemplateError(`cwd param "${paramName}" must be a non-empty string`)
      }
      if (value.split(/[\\/]+/).some((segment) => segment === "..")) {
        throw new CliTemplateError(`cwd param "${paramName}" must not contain ".." segments`)
      }
      if (!context.workspaceRoot) {
        throw new CliTemplateError("cwd policy 'param' requires an open workspace")
      }
      if (isAbsolutePath(value)) {
        if (!isInsideOrEqual(value, context.workspaceRoot)) {
          throw new CliTemplateError(
            `cwd param "${paramName}" must resolve inside the workspace root`
          )
        }
        return value
      }
      return `${normalizePath(context.workspaceRoot)}/${value.replace(/\\/g, "/")}`
    }
    default:
      throw new CliTemplateError(`unknown cwd policy kind: ${String(kind)}`)
  }
}

export function parseOutput(
  stdout: string,
  mode: PluginCliOutputParse | undefined
): string | string[] | unknown {
  switch (mode ?? "text") {
    case "text":
      return stdout.replace(/\s+$/, "")
    case "lines":
      return stdout.split(/\r?\n/).filter((line) => line.length > 0)
    case "json":
      try {
        return JSON.parse(stdout)
      } catch (error) {
        throw new CliTemplateError(
          `tool output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    default:
      throw new CliTemplateError(`unknown outputParse mode: ${String(mode)}`)
  }
}
