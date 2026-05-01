// Projection-time resolver for builtin MCP rows.
//
// The `a2ui-bridge` row (and any future builtin server) ships a placeholder
// `${COGNIA_SIDECAR_DIR}` instead of an absolute path so the row can be seeded
// at install time before the runtime paths are known. Without this resolver,
// `lib/claude/sync.ts` projects the unresolved row verbatim into external
// agent config files (`~/.claude.json`, etc.), so spawned MCP children get a
// literal placeholder string and cannot launch.
//
// Resolver behaviour:
//   - Walks `command`, every `args[i]`, and every `env[k]` value, replacing
//     the literal substring `${COGNIA_SIDECAR_DIR}` with `ctx.sidecarDir`.
//   - For the a2ui-bridge row (recognised via `isA2UIBridgeRow`), additionally
//     stamps `env.COGNIA_BRIDGE_SOCKET = ctx.socketPath` so the spawned
//     `a2ui-mcp.mjs` can connect back to the renderer.
//   - Returns the input unchanged when nothing needs to be substituted (rows
//     without placeholders that aren't the a2ui-bridge row pass through with
//     referential identity).

import type { McpServer } from "@/lib/claude/types"
import { isA2UIBridgeRow } from "@/lib/a2ui/mcp-tool-schemas"

export const COGNIA_SIDECAR_DIR_TOKEN = "${COGNIA_SIDECAR_DIR}"
export const COGNIA_BRIDGE_SOCKET_ENV = "COGNIA_BRIDGE_SOCKET"

export interface BuiltinMcpResolveContext {
  /** Absolute path to the bundled `sidecar/` directory. */
  sidecarDir: string
  /** Absolute path / named-pipe target the a2ui-bridge listener accepts on. */
  socketPath: string
}

function substitute(value: string, sidecarDir: string): string {
  if (!value.includes(COGNIA_SIDECAR_DIR_TOKEN)) return value
  // Use split/join to substitute every occurrence without invoking RegExp,
  // which would force callers to escape Windows backslashes in sidecarDir.
  return value.split(COGNIA_SIDECAR_DIR_TOKEN).join(sidecarDir)
}

function rewriteArgs(args: unknown, sidecarDir: string): { changed: boolean; value: unknown } {
  if (!Array.isArray(args)) return { changed: false, value: args }
  let changed = false
  const next: unknown[] = []
  for (const item of args) {
    if (typeof item === "string") {
      const replaced = substitute(item, sidecarDir)
      if (replaced !== item) changed = true
      next.push(replaced)
    } else {
      next.push(item)
    }
  }
  return changed ? { changed: true, value: next } : { changed: false, value: args }
}

function rewriteEnv(
  env: unknown,
  sidecarDir: string,
  injectSocketPath: string | null
): { changed: boolean; value: Record<string, unknown> | undefined } {
  const isObject = env && typeof env === "object" && !Array.isArray(env)
  if (!isObject && injectSocketPath === null) {
    return { changed: false, value: env as Record<string, unknown> | undefined }
  }
  const source = isObject ? (env as Record<string, unknown>) : {}
  const next: Record<string, unknown> = {}
  let changed = !isObject // if we're materialising a brand-new env object, it's a change
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string") {
      const replaced = substitute(v, sidecarDir)
      if (replaced !== v) changed = true
      next[k] = replaced
    } else {
      next[k] = v
    }
  }
  if (injectSocketPath !== null) {
    if (next[COGNIA_BRIDGE_SOCKET_ENV] !== injectSocketPath) {
      next[COGNIA_BRIDGE_SOCKET_ENV] = injectSocketPath
      changed = true
    }
  }
  return changed
    ? { changed: true, value: next }
    : { changed: false, value: env as Record<string, unknown> | undefined }
}

/**
 * Resolve placeholders + inject the bridge socket env on a single MCP server
 * row. Pure: never mutates the input. Returns the input unchanged when
 * nothing is replaced.
 */
export function resolveBuiltinMcpConfig(
  server: McpServer,
  ctx: BuiltinMcpResolveContext
): McpServer {
  const config = server.config ?? {}
  const command = config.command
  const args = config.args
  const env = config.env

  let changed = false
  const nextConfig: Record<string, unknown> = { ...config }

  if (typeof command === "string") {
    const replaced = substitute(command, ctx.sidecarDir)
    if (replaced !== command) {
      nextConfig.command = replaced
      changed = true
    }
  }

  const nextArgs = rewriteArgs(args, ctx.sidecarDir)
  if (nextArgs.changed) {
    nextConfig.args = nextArgs.value
    changed = true
  }

  const injectSocket = isA2UIBridgeRow(server) ? ctx.socketPath : null
  const nextEnv = rewriteEnv(env, ctx.sidecarDir, injectSocket)
  if (nextEnv.changed) {
    nextConfig.env = nextEnv.value
    changed = true
  }

  if (!changed) return server
  return { ...server, config: nextConfig }
}
