/**
 * Slash-command descriptors for MCP server management (`/mcp`). Handlers are
 * pure — they emit `runtime` effects the App routes to the MCP controller.
 */
import { rt } from "./runtime-handler"
import type { CommandArgSpec, CommandDescriptor } from "./types"

const ADD_ARGS: CommandArgSpec[] = [
  { name: "name", label: "Name", type: "string", required: true },
  {
    name: "transport",
    label: "Transport",
    type: "enum",
    options: ["stdio", "sse", "http"],
    default: "stdio",
  },
  {
    name: "command",
    label: "Command (stdio)",
    type: "string",
    placeholder: "npx -y @scope/server",
  },
  { name: "url", label: "URL (sse/http)", type: "string", placeholder: "https://host/mcp" },
]

export const MCP_COMMANDS: CommandDescriptor[] = [
  {
    name: "mcp",
    description: "list, add, enable, or disable MCP servers",
    category: "mcp",
    handler: rt("mcp", "list"),
    subcommands: [
      { name: "list", description: "browse MCP servers", handler: rt("mcp", "list") },
      { name: "add", description: "add an MCP server", args: ADD_ARGS, handler: rt("mcp", "add") },
      { name: "enable", description: "enable a server by name", handler: rt("mcp", "enable") },
      { name: "disable", description: "disable a server by name", handler: rt("mcp", "disable") },
      { name: "toggle", description: "toggle a server by name", handler: rt("mcp", "toggle") },
    ],
  },
]
