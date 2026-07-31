/**
 * Slash-command descriptor for the unified log panel (`/logs`). The handler is
 * pure — it emits a `runtime` effect the App routes to the log controller.
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const LOG_COMMANDS: CommandDescriptor[] = [
  {
    name: "logs",
    description: "view captured logs across agents, MCP servers, and the backend",
    category: "system",
    handler: rt("logs", "panel"),
  },
]
