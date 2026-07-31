/**
 * How an external agent is told to start the Cognia tool bridge.
 *
 * The bridge ships inside the sidecar bundle (that is where the real tool
 * definitions and handlers live), so launching it reuses the sidecar's own
 * resolution rules: a script path in dev, a self-exec of the packaged binary
 * when there is no system Node.
 *
 * The broker endpoint and token travel in ENV, never argv — argv is readable by
 * any local process via `ps`, and the token is a capability that authorises tool
 * execution against a live Cognia session.
 */

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import type { AcpMcpServerConfig } from "@/types/agent/external-agent"

import { isPackaged } from "../../runtime/bootstrap"
import {
  COGNIA_PLUGIN_TOOLS_SERVER,
  COGNIA_TOOLS_SERVER,
  TOOL_HOST_ENV,
  type ToolHostServerName,
} from "./protocol"

export interface ResolveBridgeOptions {
  env?: Record<string, string | undefined>
  execPath?: string
  exists?: (p: string) => boolean
  packaged?: boolean
}

/**
 * Locate `sidecar/cognia-tool-bridge.mjs`. Mirrors `resolveSidecarScript`:
 *   1. `$COGNIA_TOOL_BRIDGE_SCRIPT` (explicit override)
 *   2. a `sidecar/` dir next to the executable (packaged-binary dist layout)
 *   3. a `sidecar/` dir walked up from this module (in-repo / dev)
 */
export function resolveToolBridgeScript(opts: ResolveBridgeOptions = {}): string {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? fs.existsSync
  const execPath = opts.execPath ?? process.execPath

  const override = env.COGNIA_TOOL_BRIDGE_SCRIPT?.trim()
  if (override) return override

  const adjacent = path.join(path.dirname(execPath), "sidecar", "cognia-tool-bridge.mjs")
  if (exists(adjacent)) return adjacent

  let dir: string
  try {
    dir = path.dirname(fileURLToPath(import.meta.url))
  } catch {
    dir = typeof __dirname === "string" ? __dirname : process.cwd()
  }
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "sidecar", "cognia-tool-bridge.mjs")
    if (exists(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    "could not locate sidecar/cognia-tool-bridge.mjs — set COGNIA_TOOL_BRIDGE_SCRIPT to its absolute path"
  )
}

export interface ToolHostMcpParams {
  endpoint: string
  token: string
  /** Which servers to attach. Defaults to both Cognia namespaces. */
  servers?: ToolHostServerName[]
  script?: string
  execPath?: string
  packaged?: boolean
}

/**
 * Build the `mcpServers` entries that expose Cognia's tools to the agent.
 *
 * Two entries, not one: MCP namespaces tools by SERVER name, and the built-in
 * and host planes must keep their distinct `mcp__cognia-tools__*` /
 * `mcp__cognia-plugin-tools__*` prefixes so tool policy, rendering and the
 * agent's own reasoning about them stay identical to the built-in backend.
 */
export function buildToolHostMcpServers(params: ToolHostMcpParams): AcpMcpServerConfig[] {
  const packaged = params.packaged ?? isPackaged()
  const script = params.script ?? resolveToolBridgeScript()
  const execPath = params.execPath ?? process.execPath
  const servers = params.servers ?? [COGNIA_TOOLS_SERVER, COGNIA_PLUGIN_TOOLS_SERVER]
  return servers.map((name) => {
    // ACP models env as a name/value LIST, not a record.
    const env = [
      { name: TOOL_HOST_ENV.socket, value: params.endpoint },
      { name: TOOL_HOST_ENV.token, value: params.token },
      { name: TOOL_HOST_ENV.server, value: name },
      ...(packaged
        ? [
            { name: "COGNIA_ROLE", value: "tool-bridge" },
            { name: "COGNIA_SIDECAR_SCRIPT", value: script },
          ]
        : []),
    ]
    return {
      name,
      // No system Node inside the packaged binary — self-exec with the role env,
      // exactly as the sidecar bootstrap does.
      command: packaged ? execPath : process.execPath,
      args: packaged ? [] : [script],
      env,
    } as AcpMcpServerConfig
  })
}

/** The namespaces Cognia auto-acknowledges on the agent's own permission ask. */
export const COGNIA_TOOL_NAMESPACES: readonly string[] = [
  `mcp__${COGNIA_TOOLS_SERVER}__`,
  `mcp__${COGNIA_PLUGIN_TOOLS_SERVER}__`,
]

/**
 * Is `toolName` a Cognia-projected tool?
 *
 * Used to auto-acknowledge the EXTERNAL agent's own permission request for our
 * namespaces. That acknowledgement is not an execution approval — the broker
 * still gates the call — it exists so one Cognia tool call never produces two
 * prompts: the agent's generic "may I call this MCP tool?" and Cognia's real
 * one, which is the authoritative decision.
 */
export function isCogniaProjectedTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  return COGNIA_TOOL_NAMESPACES.some((prefix) => toolName.startsWith(prefix))
}
