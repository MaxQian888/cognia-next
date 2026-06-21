/**
 * @jest-environment node
 */
import { buildCommandHelpDocument } from "./command-help"
import type { CommandDescriptor } from "./types"

describe("buildCommandHelpDocument", () => {
  it("renders the name, description, aliases, usage, args, and subcommands", () => {
    const desc: CommandDescriptor = {
      name: "mcp",
      aliases: ["servers"],
      description: "manage MCP servers",
      category: "mcp",
      argumentHint: "<add | list | remove>",
      args: [
        { name: "name", label: "Server name", type: "string", required: true },
        { name: "transport", label: "Transport", type: "enum", options: ["stdio", "sse"] },
      ],
      subcommands: [
        {
          name: "add",
          description: "add a server",
          argumentHint: "<name>",
          handler: () => ({ kind: "none" }),
        },
        { name: "list", description: "list servers", handler: () => ({ kind: "none" }) },
      ],
    }
    const { title, body } = buildCommandHelpDocument(desc)
    expect(title).toBe("Help: /mcp")
    expect(body).toContain("# /mcp")
    expect(body).toContain("**Aliases:** /servers")
    expect(body).toContain("manage MCP servers")
    expect(body).toContain("**Usage:** `/mcp <add | list | remove>`")
    expect(body).toContain("## Arguments")
    expect(body).toContain("`name`")
    expect(body).toContain("one of: stdio, sse")
    expect(body).toContain("_(optional)_") // transport is not required
    expect(body).toContain("## Subcommands")
    expect(body).toContain("`/mcp add <name>` — add a server")
    expect(body).toContain("`/mcp list` — list servers")
  })

  it("renders a minimal command without optional sections", () => {
    const desc: CommandDescriptor = {
      name: "exit",
      description: "quit",
      category: "system",
    }
    const { body } = buildCommandHelpDocument(desc)
    expect(body).toContain("# /exit")
    expect(body).toContain("quit")
    expect(body).not.toContain("## Arguments")
    expect(body).not.toContain("## Subcommands")
    expect(body).not.toContain("**Aliases:**")
  })
})
