/**
 * Pure helpers for declarative CLI tools: argv token substitution, cwd
 * policy resolution, and output parsing. No I/O — every safety property
 * the executor relies on is testable here in isolation.
 *
 * Injection model: a `{ param }` token substitutes as EXACTLY ONE argv
 * element (arrays expand to N elements, each optionally prefixed). Values
 * are never concatenated into a shell string and the program name is never
 * templated, so `; rm -rf /` in a value stays a literal argument.
 */

import type { PluginCliArgvToken, PluginCliCwdPolicy, PluginCliOutputParse } from "@/types/plugin"

/** Thrown for template-level failures (missing params, bad shapes). */
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

/** Render one param value into argv elements. */
function renderValue(name: string, value: unknown, eachPrefixedBy?: string): string[] {
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const element of value) {
      if (typeof element === "object" && element !== null) {
        throw new CliTemplateError(`argv param "${name}" array elements must be scalars`)
      }
      if (eachPrefixedBy !== undefined) {
        out.push(eachPrefixedBy)
      }
      out.push(String(element))
    }
    return out
  }
  if (value === true) {
    // Flag semantics: a true boolean with a prefix emits just the flag.
    if (eachPrefixedBy !== undefined) {
      return [eachPrefixedBy]
    }
    return ["true"]
  }
  if (typeof value === "object" && value !== null) {
    throw new CliTemplateError(`argv param "${name}" must be a scalar or array, got object`)
  }
  const rendered = String(value)
  return eachPrefixedBy !== undefined ? [eachPrefixedBy, rendered] : [rendered]
}

/**
 * Substitute the manifest's argv token template with the call's params.
 * Each value lands as discrete argv elements — never shell-joined.
 */
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
      if (token.omitWhenEmpty) {
        continue
      }
      throw new CliTemplateError(`missing required value for argv param "${token.param}"`)
    }
    argv.push(...renderValue(token.param, value, token.eachPrefixedBy))
  }
  return argv
}

// ─── cwd policy ──────────────────────────────────────────────────────────────

function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/g, "")
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const c = normalisePath(child).toLowerCase()
  const p = normalisePath(parent).toLowerCase()
  return c === p || c.startsWith(p + "/")
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)
}

export interface CwdContext {
  pluginPath: string
  workspaceRoot: string | undefined
}

/**
 * Resolve the manifest cwd policy to an absolute directory (or undefined
 * for "none"). A `param` cwd must land inside the workspace root —
 * relative values join onto it, absolute values must already be inside.
 */
export function resolveCwd(
  policy: PluginCliCwdPolicy | undefined,
  params: Record<string, unknown>,
  ctx: CwdContext
): string | undefined {
  const kind = policy?.kind ?? "none"
  switch (kind) {
    case "none":
      return undefined
    case "plugin-dir":
      return ctx.pluginPath
    case "workspace":
      if (!ctx.workspaceRoot) {
        throw new CliTemplateError("cwd policy 'workspace' requires an open workspace")
      }
      return ctx.workspaceRoot
    case "param": {
      const paramName = (policy as { param?: string }).param
      const value = paramName ? params[paramName] : undefined
      if (typeof value !== "string" || value.length === 0) {
        throw new CliTemplateError(`cwd param "${paramName}" must be a non-empty string`)
      }
      if (value.split(/[\\/]+/).some((segment) => segment === "..")) {
        throw new CliTemplateError(`cwd param "${paramName}" must not contain ".." segments`)
      }
      if (!ctx.workspaceRoot) {
        throw new CliTemplateError("cwd policy 'param' requires an open workspace")
      }
      if (isAbsolutePath(value)) {
        if (!isInsideOrEqual(value, ctx.workspaceRoot)) {
          throw new CliTemplateError(
            `cwd param "${paramName}" must resolve inside the workspace root`
          )
        }
        return value
      }
      return `${normalisePath(ctx.workspaceRoot)}/${value.replace(/\\/g, "/")}`
    }
    default:
      throw new CliTemplateError(`unknown cwd policy kind: ${String(kind)}`)
  }
}

// ─── output parsing ──────────────────────────────────────────────────────────

/**
 * Turn captured stdout into the tool result per the manifest's
 * `outputParse` mode.
 */
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
