/**
 * @jest-environment node
 */
import {
  mcpAdd,
  mcpList,
  mcpSetEnabled,
  mcpShow,
  mcpTools,
  mcpToggle,
  parseFlags,
} from "./mcp-controller"
import type { McpServer } from "@/lib/claude/types"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const server = (name: string, enabled = true): McpServer =>
  ({ id: `mcp_${name}`, name, transport: "stdio", config: {}, enabled }) as McpServer

const base = { roots: ["/w"], home: "/home" }

describe("parseFlags", () => {
  it("parses flags with multi-token values", () => {
    expect(parseFlags("--name fs --transport stdio --command npx -y server")).toEqual({
      name: "fs",
      transport: "stdio",
      command: "npx -y server",
    })
  })
  it("returns empty for no flags", () => {
    expect(parseFlags("")).toEqual({})
  })
})

describe("mcpList", () => {
  it("opens a select overlay wired to `mcp show`", () => {
    const { dispatch, actions } = recorder()
    mcpList({ ...base, dispatch, load: () => [server("fs"), server("git", false)] })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "mcp show",
        items: [
          { id: "fs", hint: "stdio · on" },
          { id: "git", hint: "stdio · off" },
        ],
      },
    })
  })
  it("notices when none are configured", () => {
    const { dispatch, actions } = recorder()
    mcpList({ ...base, dispatch, load: () => [] })
    expect((actions[0] as { message: string }).message).toContain("No MCP servers")
  })
})

describe("mcpShow", () => {
  it("renders stdio config detail with redacted env keys", () => {
    const { dispatch, actions } = recorder()
    const srv = {
      id: "mcp_fs",
      name: "fs",
      transport: "stdio",
      enabled: true,
      config: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "secret" } },
    } as McpServer
    mcpShow("fs", { ...base, dispatch, load: () => [srv] })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("fs — enabled")
    expect(msg).toContain("transport: stdio")
    expect(msg).toContain("command: npx -y srv")
    expect(msg).toContain("env: TOKEN")
    expect(msg).not.toContain("secret")
    expect(msg).toContain("/mcp tools fs")
  })
  it("renders http url + header keys and a plugin source", () => {
    const { dispatch, actions } = recorder()
    const srv = {
      id: "mcp_remote",
      name: "remote",
      transport: "http",
      enabled: false,
      pluginId: "my-plugin",
      config: { url: "https://x/mcp", headers: { Authorization: "Bearer z" } },
    } as McpServer
    mcpShow("remote", { ...base, dispatch, load: () => [srv] })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("remote — disabled")
    expect(msg).toContain("url: https://x/mcp")
    expect(msg).toContain("headers: Authorization")
    expect(msg).not.toContain("Bearer z")
    expect(msg).toContain("source: plugin my-plugin")
  })
  it("requires a name and reports unknown servers", () => {
    const r1 = recorder()
    mcpShow("", { ...base, dispatch: r1.dispatch, load: () => [] })
    expect((r1.actions[0] as { message: string }).message).toContain("Usage")
    const r2 = recorder()
    mcpShow("ghost", { ...base, dispatch: r2.dispatch, load: () => [] })
    expect((r2.actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("mcpTools", () => {
  it("probes the server and opens a view-only tool list", async () => {
    const { dispatch, actions } = recorder()
    await mcpTools("fs", {
      ...base,
      dispatch,
      load: () => [server("fs")],
      probe: async () => [
        { name: "read_file", description: "read a file" },
        { name: "write_file" },
      ],
    })
    expect((actions[0] as { message: string }).message).toContain("Connecting")
    expect(actions[1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        title: "Tools — fs (2)",
        items: [{ id: "read_file", hint: "read a file" }, { id: "write_file" }],
      },
    })
    // View-only: no re-dispatch command.
    expect(
      (actions[1] as { overlay: { onSelectCommand?: string } }).overlay.onSelectCommand
    ).toBeUndefined()
  })
  it("reports a probe failure instead of crashing", async () => {
    const { dispatch, actions } = recorder()
    await mcpTools("fs", {
      ...base,
      dispatch,
      load: () => [server("fs")],
      probe: async () => {
        throw new Error("connection refused")
      },
    })
    expect((actions[1] as { message: string }).message).toContain("Could not list tools")
    expect((actions[1] as { message: string }).message).toContain("connection refused")
  })
  it("notices when the server advertises no tools", async () => {
    const { dispatch, actions } = recorder()
    await mcpTools("fs", { ...base, dispatch, load: () => [server("fs")], probe: async () => [] })
    expect((actions[1] as { message: string }).message).toContain("no tools")
  })
  it("requires a name and reports unknown servers", async () => {
    const r1 = recorder()
    await mcpTools("", { ...base, dispatch: r1.dispatch, load: () => [] })
    expect((r1.actions[0] as { message: string }).message).toContain("Usage")
    const r2 = recorder()
    await mcpTools("ghost", { ...base, dispatch: r2.dispatch, load: () => [] })
    expect((r2.actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("mcpToggle", () => {
  it("disables a currently-enabled server", () => {
    const { dispatch, actions } = recorder()
    let toggled: { name: string; disabled: boolean } | null = null
    mcpToggle("fs", {
      ...base,
      dispatch,
      load: () => [server("fs", true)],
      setServerDisabled: (name, disabled) => {
        toggled = { name, disabled }
      },
    })
    expect(toggled).toEqual({ name: "fs", disabled: true })
    expect((actions[0] as { message: string }).message).toContain("disabled")
  })
  it("notices an unknown server", () => {
    const { dispatch, actions } = recorder()
    mcpToggle("ghost", { ...base, dispatch, load: () => [] })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("mcpSetEnabled", () => {
  it("maps enabled→not-disabled", () => {
    let captured: { name: string; disabled: boolean } | null = null
    mcpSetEnabled("fs", true, {
      ...base,
      dispatch: () => {},
      setServerDisabled: (name, disabled) => {
        captured = { name, disabled }
      },
    })
    expect(captured).toEqual({ name: "fs", disabled: false })
  })
})

describe("mcpAdd", () => {
  it("writes a stdio server", () => {
    const { dispatch, actions } = recorder()
    let added: unknown = null
    mcpAdd("--name fs --transport stdio --command npx --args -y srv", {
      ...base,
      dispatch,
      addServer: (name, transport, config) => {
        added = { name, transport, config }
      },
    })
    expect(added).toEqual({
      name: "fs",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "srv"] },
    })
    expect((actions[0] as { message: string }).message).toContain("Added MCP server")
  })

  it("requires a name", () => {
    const { dispatch, actions } = recorder()
    mcpAdd("--transport stdio", { ...base, dispatch, addServer: () => {} })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("requires --command for stdio and --url for http", () => {
    const r1 = recorder()
    mcpAdd("--name x", { ...base, dispatch: r1.dispatch, addServer: () => {} })
    expect((r1.actions[0] as { message: string }).message).toContain("--command")
    const r2 = recorder()
    mcpAdd("--name x --transport http", { ...base, dispatch: r2.dispatch, addServer: () => {} })
    expect((r2.actions[0] as { message: string }).message).toContain("--url")
  })

  it("writes an http server with a url", () => {
    let added: unknown = null
    mcpAdd("--name remote --transport http --url https://x/mcp", {
      ...base,
      dispatch: () => {},
      addServer: (name, transport, config) => {
        added = { name, transport, config }
      },
    })
    expect(added).toEqual({ name: "remote", transport: "http", config: { url: "https://x/mcp" } })
  })
})
