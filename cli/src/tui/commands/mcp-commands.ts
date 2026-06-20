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
  { name: "preset", label: "Preset id (see /mcp presets)", type: "string", placeholder: "github" },
]

export const MCP_COMMANDS: CommandDescriptor[] = [
  {
    name: "mcp",
    description: "list, add, enable, or disable MCP servers",
    category: "mcp",
    handler: rt("mcp", "list"),
    subcommands: [
      { name: "list", description: "browse MCP servers", handler: rt("mcp", "list") },
      {
        name: "show",
        description: "show a server's config detail",
        argumentHint: "<name>",
        handler: rt("mcp", "show"),
      },
      {
        name: "tools",
        description: "connect and list a server's tools",
        argumentHint: "<name>",
        handler: rt("mcp", "tools"),
      },
      {
        name: "resources",
        description: "connect and list a server's resources",
        argumentHint: "<name>",
        handler: rt("mcp", "resources"),
      },
      {
        name: "prompts",
        description: "connect and list a server's prompts",
        argumentHint: "<name>",
        handler: rt("mcp", "prompts"),
      },
      {
        name: "auth",
        description: "authorize a remote server via OAuth",
        argumentHint: "<name>",
        handler: rt("mcp", "auth"),
      },
      {
        name: "logout",
        description: "clear a server's stored OAuth credentials",
        argumentHint: "<name>",
        handler: rt("mcp", "logout"),
      },
      {
        name: "presets",
        description: "browse built-in + plugin MCP server presets",
        handler: rt("mcp", "presets"),
      },
      { name: "add", description: "add an MCP server", args: ADD_ARGS, handler: rt("mcp", "add") },
      {
        name: "enable",
        description: "enable a server by name",
        argumentHint: "<name>",
        handler: rt("mcp", "enable"),
      },
      {
        name: "disable",
        description: "disable a server by name",
        argumentHint: "<name>",
        handler: rt("mcp", "disable"),
      },
      {
        name: "toggle",
        description: "toggle a server by name",
        argumentHint: "<name>",
        handler: rt("mcp", "toggle"),
      },
    ],
  },
]
