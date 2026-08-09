import path from "node:path"
import fs from "node:fs"
import { pathToFileURL } from "node:url"

export function resolveMcpRelayScript(
  env: Record<string, string | undefined> = process.env,
  execPath = process.execPath,
  exists: (path: string) => boolean = fs.existsSync
): string {
  const explicit = env.COGNIA_MCP_RELAY_SCRIPT?.trim()
  if (explicit) return explicit
  const adjacent = path.join(path.dirname(execPath), "sidecar", "mcp-stdio-relay.mjs")
  if (exists(adjacent)) return adjacent
  throw new Error("could not locate sidecar/mcp-stdio-relay.mjs")
}

export interface McpRelayRoleDeps {
  resolveScript?: typeof resolveMcpRelayScript
  importer?: (url: string) => Promise<{ runMcpStdioRelay?: () => Promise<void> }>
}

/** Run the packaged binary as the stdio-facing guarded MCP relay. */
export async function runMcpRelayRole(deps: McpRelayRoleDeps = {}): Promise<void> {
  const resolve = deps.resolveScript ?? resolveMcpRelayScript
  const importer = deps.importer ?? ((url: string) => import(url))
  const relayModule = await importer(pathToFileURL(resolve()).href)
  if (typeof relayModule.runMcpStdioRelay !== "function") {
    throw new Error("MCP relay module does not export runMcpStdioRelay")
  }
  await relayModule.runMcpStdioRelay()
}
