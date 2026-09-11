/**
 * @jest-environment node
 */
import { buildCommandHelpDocument } from "./command-help"
import type { CommandDescriptor } from "./types"

describe("buildCommandHelpDocument", () => {
  it("renders the name, description, aliases, usage, args, and subcommands", () => {
    const desc: CommandDescriptor = {
      name: "custom-mcp",
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
    expect(title).toBe("Help: /custom-mcp")
    expect(body).toContain("# /custom-mcp")
    expect(body).toContain("**Aliases:** /servers")
    expect(body).toContain("manage MCP servers")
    expect(body).toContain("**Usage:** `/custom-mcp <add | list | remove>`")
    expect(body).toContain("## Arguments")
    expect(body).toContain("`name`")
    expect(body).toContain("one of: stdio, sse")
    expect(body).toContain("_(optional)_") // transport is not required
    expect(body).toContain("## Subcommands")
    expect(body).toContain("`/custom-mcp add <name>` — add a server")
    expect(body).toContain("`/custom-mcp list` — list servers")
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

it("localizes built-in detail and nested parameters while preserving command syntax", () => {
  const doc = buildCommandHelpDocument(
    {
      name: "mcp",
      category: "mcp",
      description: "manage MCP servers",
      aliases: ["servers"],
      argumentHint: "<action>",
      subcommands: [
        {
          name: "add",
          description: "add an MCP server",
          handler: () => ({ kind: "none" }),
          args: [
            { name: "name", label: "Name", type: "string", required: true },
            { name: "transport", label: "Transport", type: "enum", options: ["stdio", "sse"] },
            { name: "custom", label: "Plugin parameter", type: "string" },
          ],
        },
      ],
    },
    "zh-CN"
  )
  expect(doc.title).toBe("帮助：/mcp")
  expect(doc.body).toContain("**别名：** /servers")
  expect(doc.body).toContain("**用法：** `/mcp <action>`")
  expect(doc.body).toContain("## 子命令")
  expect(doc.body).toContain("添加 MCP 服务器")
  expect(doc.body).toContain("`transport` _(可选)_ — 传输方式 — 可选值：stdio, sse")
  expect(doc.body).toContain("Plugin parameter")
})
it("preserves contributed description and optional arguments without labels or enum choices", () => {
  const doc = buildCommandHelpDocument(
    {
      name: "custom",
      category: "custom",
      description: "Custom text",
      args: [{ name: "x", type: "enum", options: [], label: "x" }],
      subcommands: [{ name: "run", description: "Plugin verb", handler: () => ({ kind: "none" }) }],
    },
    "zh-CN"
  )
  expect(doc.body).toContain("Custom text")
  expect(doc.body).toContain("## 参数")
  expect(doc.body).toContain("Plugin verb")
  expect(doc.body).not.toContain("可选值")
})
