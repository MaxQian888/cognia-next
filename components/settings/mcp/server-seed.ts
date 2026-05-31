/**
 * Builds a blank create-seed for a new MCP server, pre-projecting it to every
 * detected writable agent. Mirrors the legacy gallery's "custom" path so a
 * hand-made server lands in the agents' config files by default (the user can
 * toggle individual agent chips off afterwards).
 *
 * Kept out of `mcp-server-utils.ts` (which stays dependency-free / pure) since
 * it reaches into the agent-detection layer. Shared by the panel's preset
 * handler and the "My Servers" tab's add button to avoid a circular import.
 */

import { getDetectedWritableAgents } from "@/hooks/agent"
import type { McpEditorSeed } from "@/stores/mcp/mcp-panel-store"

export async function blankServerSeed(): Promise<McpEditorSeed> {
  const appsEnabled: Record<string, boolean> = {}
  for (const id of await getDetectedWritableAgents()) appsEnabled[id] = true
  return {
    name: "",
    transport: "stdio",
    config: { command: "", args: [] },
    enabled: true,
    appsEnabled,
  }
}
