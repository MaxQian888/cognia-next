/**
 * Tool-bridge role for the packaged binary.
 *
 * An external agent spawns `cognia-agent` with `COGNIA_ROLE=tool-bridge` as an
 * ordinary stdio MCP server (see `agent/tool-host/spawn.ts`). The bridge itself
 * lives in the SIDECAR bundle, because that is where the real Cognia tool
 * definitions and handlers already are — so this role does exactly what
 * {@link runSidecarRole} does: import the bundle and let it start.
 *
 * The bundle recognises `COGNIA_ROLE === "tool-bridge"` as an entry signal (its
 * `argv[1]` check would miss, since we import rather than exec it), and the open
 * stdin interface keeps the process alive. Collaborators are injected so this
 * unit-tests without a real import.
 */

import { pathToFileURL } from "node:url"

import { resolveToolBridgeScript } from "../agent/tool-host/spawn"

export interface ToolBridgeRoleDeps {
  /** Locate the bridge script. Defaults to {@link resolveToolBridgeScript}. */
  resolveScript?: () => string
  /** Dynamic-import a module by URL. Injected for tests. */
  importer?: (url: string) => Promise<unknown>
}

/** Start the Cognia tool bridge in this process by importing its bundle. */
export async function runToolBridgeRole(deps: ToolBridgeRoleDeps = {}): Promise<void> {
  const resolve = deps.resolveScript ?? (() => resolveToolBridgeScript())
  const importer = deps.importer ?? ((url: string) => import(url))
  await importer(pathToFileURL(resolve()).href)
}
