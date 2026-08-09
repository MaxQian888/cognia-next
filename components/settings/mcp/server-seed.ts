/**
 * Builds a fail-closed create seed. New definitions require trust review and
 * explicit Agent target selection before they can connect or write plaintext
 * credentials into an external config file.
 */

import type { McpEditorSeed } from "@/stores/mcp/mcp-panel-store"

export async function blankServerSeed(): Promise<McpEditorSeed> {
  return {
    name: "",
    transport: "stdio",
    config: { command: "", args: [] },
    enabled: false,
    appsEnabled: {},
  }
}
