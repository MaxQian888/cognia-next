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
