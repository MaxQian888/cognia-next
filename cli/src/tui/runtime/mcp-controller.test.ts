/**
 * @jest-environment node
 */
import {
  mcpAdd,
  mcpAuth,
  mcpList,
  mcpLogout,
  mcpPresets,
  mcpPrompts,
  mcpResources,
  mcpSetEnabled,
  mcpShow,
  mcpTools,
  mcpToggle,
  parseFlags,
  probeAuthProvider,
} from "./mcp-controller"
import { patchAuthEntry } from "../../mcp/oauth-store"
import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpProbeResult } from "../../mcp/probe-mcp-server"
import type { McpServer } from "@/lib/claude/types"
import type { TuiAction } from "../state/types"

const ok = (over: Partial<McpProbeResult> = {}): McpProbeResult => ({
  status: "connected",
  tools: [],
  resources: [],
  prompts: [],
  ...over,
})

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
  it("probes each server and shows its live status in the overlay", async () => {
    const { dispatch, actions } = recorder()
    await mcpList({
      ...base,
      dispatch,
      load: () => [server("fs"), server("git", false), server("remote")],
      probeServer: async (s) =>
        s.name === "remote"
          ? ok({ status: "needs_auth" })
          : ok({ status: s.enabled ? "connected" : "disabled" }),
    })
    expect((actions[0] as { message: string }).message).toContain("Probing 3 MCP servers")
    expect(actions[1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "mcp show",
        items: [
          { id: "fs", hint: "stdio · ✓ connected" },
          { id: "git", hint: "stdio · ○ disabled" },
          { id: "remote", hint: "stdio · ⚠ needs auth" },
        ],
      },
    })
  })
  it("marks a probe that throws as failed", async () => {
    const { dispatch, actions } = recorder()
    await mcpList({
      ...base,
      dispatch,
      load: () => [server("fs")],
      probeServer: async () => {
        throw new Error("boom")
      },
    })
    expect(actions[1]).toMatchObject({
      overlay: { items: [{ id: "fs", hint: "stdio · ✗ failed" }] },
    })
  })
  it("notices when none are configured", async () => {
    const { dispatch, actions } = recorder()
    await mcpList({ ...base, dispatch, load: () => [] })
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
    } as unknown as McpServer
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
    } as unknown as McpServer
    mcpShow("remote", { ...base, dispatch, load: () => [srv] })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("remote — disabled")
    expect(msg).toContain("url: https://x/mcp")
    expect(msg).toContain("headers: Authorization")
    expect(msg).not.toContain("Bearer z")
    expect(msg).toContain("source: plugin my-plugin")
  })
  it("shows the auth state for a remote server", () => {
    const remote = {
      id: "mcp_r",
      name: "r",
      transport: "http",
      enabled: true,
      config: { url: "https://x" },
    } as unknown as McpServer
    const signedOut = recorder()
    mcpShow("r", {
      ...base,
      dispatch: signedOut.dispatch,
      load: () => [remote],
      hasTokens: () => false,
    })
    expect((signedOut.actions[0] as { message: string }).message).toContain(
      "auth: not signed in (/mcp auth r)"
    )
    const signedIn = recorder()
    mcpShow("r", {
      ...base,
      dispatch: signedIn.dispatch,
      load: () => [remote],
      hasTokens: () => true,
    })
    expect((signedIn.actions[0] as { message: string }).message).toContain(
      "auth: signed in (/mcp logout r)"
    )
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

const remoteSrv = (name = "remote"): McpServer =>
  ({
    id: `mcp_${name}`,
    name,
    transport: "http",
    config: { url: "https://x" },
    enabled: true,
  }) as unknown as McpServer

describe("mcpResources / mcpPrompts", () => {
  it("opens a resources document on a connected server", async () => {
    const { dispatch, actions } = recorder()
    await mcpResources("remote", {
      ...base,
      dispatch,
      load: () => [remoteSrv()],
      probeServer: async () => ok({ resources: [{ uri: "file://a", name: "A" }] }),
    })
    expect((actions[0] as { message: string }).message).toContain("Connecting")
    expect(actions[1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "Resources · remote (1)" },
    })
    expect((actions[1] as { overlay: { body: string } }).overlay.body).toContain("### A")
  })
  it("opens a prompts document on a connected server", async () => {
    const { dispatch, actions } = recorder()
    await mcpPrompts("remote", {
      ...base,
      dispatch,
      load: () => [remoteSrv()],
      probeServer: async () => ok({ prompts: [{ name: "summarize" }] }),
    })
    expect(actions[1]).toMatchObject({ overlay: { title: "Prompts · remote (1)" } })
    expect((actions[1] as { overlay: { body: string } }).overlay.body).toContain("### summarize")
  })
  it("points at /mcp auth when the server needs authorization", async () => {
    const { dispatch, actions } = recorder()
    await mcpResources("remote", {
      ...base,
      dispatch,
      load: () => [remoteSrv()],
      probeServer: async () => ok({ status: "needs_auth" }),
    })
    expect((actions[1] as { message: string }).message).toContain("/mcp auth remote")
  })
  it("reports a failed connection", async () => {
    const { dispatch, actions } = recorder()
    await mcpPrompts("remote", {
      ...base,
      dispatch,
      load: () => [remoteSrv()],
      probeServer: async () => ok({ status: "failed", error: "ECONNREFUSED" }),
    })
    expect((actions[1] as { message: string }).message).toContain("ECONNREFUSED")
  })
  it("requires a name and reports unknown servers", async () => {
    const r1 = recorder()
    await mcpResources("", { ...base, dispatch: r1.dispatch, load: () => [] })
    expect((r1.actions[0] as { message: string }).message).toContain("Usage")
    const r2 = recorder()
    await mcpPrompts("ghost", { ...base, dispatch: r2.dispatch, load: () => [] })
    expect((r2.actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("mcpAuth", () => {
  it("runs the OAuth flow and reports the result", async () => {
    const { dispatch, actions } = recorder()
    let authedServer: McpServer | null = null
    await mcpAuth("remote", {
      ...base,
      dispatch,
      load: () => [remoteSrv()],
      authenticate: async (server, onAuthUrl) => {
        authedServer = server
        onAuthUrl("https://auth/authorize")
        return { ok: true, status: "authorized", message: '"remote" authorized.' }
      },
    })
    expect(authedServer).not.toBeNull()
    expect((actions[0] as { message: string }).message).toContain("opening your browser")
    expect((actions[1] as { message: string }).message).toContain("https://auth/authorize")
    expect((actions[2] as { message: string }).message).toContain("authorized")
  })
  it("rejects a stdio server", async () => {
    const { dispatch, actions } = recorder()
    await mcpAuth("fs", {
      ...base,
      dispatch,
      load: () => [server("fs")],
      authenticate: async () => {
        throw new Error("should not be called")
      },
    })
    expect((actions[0] as { message: string }).message).toContain("stdio server")
  })
  it("requires a name and reports unknown servers", async () => {
    const r1 = recorder()
    await mcpAuth("", { ...base, dispatch: r1.dispatch, load: () => [] })
    expect((r1.actions[0] as { message: string }).message).toContain("Usage")
    const r2 = recorder()
    await mcpAuth("ghost", { ...base, dispatch: r2.dispatch, load: () => [] })
    expect((r2.actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("mcpLogout", () => {
  it("clears credentials and confirms", () => {
    const { dispatch, actions } = recorder()
    let cleared: string | null = null
    mcpLogout("remote", {
      ...base,
      dispatch,
      logout: (n) => {
        cleared = n
        return true
      },
    })
    expect(cleared).toBe("remote")
    expect((actions[0] as { message: string }).message).toContain("Signed out")
  })
  it("notes when there were no stored credentials", () => {
    const { dispatch, actions } = recorder()
    mcpLogout("remote", { ...base, dispatch, logout: () => false })
    expect((actions[0] as { message: string }).message).toContain("No stored credentials")
  })
  it("requires a name", () => {
    const { dispatch, actions } = recorder()
    mcpLogout("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })
})

describe("mcpTools", () => {
  it("probes the server and opens a scrollable tool document with schemas", async () => {
    const { dispatch, actions } = recorder()
    await mcpTools("fs", {
      ...base,
      dispatch,
      load: () => [server("fs")],
      probe: async () => [
        {
          name: "read_file",
          description: "read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
        { name: "write_file" },
      ],
    })
    expect((actions[0] as { message: string }).message).toContain("Connecting")
    expect(actions[1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", title: "Tools · fs (2)" },
    })
    const body = (actions[1] as { overlay: { body: string } }).overlay.body
    expect(body).toContain("### read_file")
    expect(body).toContain("read a file")
    expect(body).toContain('"path"')
    expect(body).toContain("### write_file")
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

const catalogStub = () =>
  Promise.resolve([
    {
      source: "built-in",
      preset: {
        id: "github",
        name: "GitHub",
        description: "gh",
        icon: "🐙",
        transport: "stdio" as const,
        config: { command: "npx", args: ["-y", "srv"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" } },
        fields: [
          {
            key: "GITHUB_PERSONAL_ACCESS_TOKEN",
            label: "token",
            placement: "env" as const,
            secret: true,
          },
        ],
      },
    },
    {
      source: "plugin:linear",
      preset: {
        id: "linear-remote",
        name: "Linear",
        description: "pm",
        icon: "📐",
        transport: "http" as const,
        config: { url: "https://mcp.linear.app/mcp" },
        fields: [],
      },
    },
  ])

describe("mcpPresets", () => {
  it("renders the built-in + plugin gallery with add hints", async () => {
    const { dispatch, actions } = recorder()
    await mcpPresets({ ...base, dispatch, collectPresets: catalogStub })
    const doc = actions[0] as { overlay: { title: string; body: string } }
    expect(doc.overlay.title).toContain("MCP presets (2)")
    expect(doc.overlay.body).toContain("GitHub")
    expect(doc.overlay.body).toContain("`github`")
    expect(doc.overlay.body).toContain("Required: `--GITHUB_PERSONAL_ACCESS_TOKEN")
    expect(doc.overlay.body).toContain("plugin:linear")
    expect(doc.overlay.body).toContain("/mcp add --preset linear-remote")
  })
})

describe("mcpAdd --preset", () => {
  it("instantiates a preset with field values", async () => {
    let added: unknown = null
    const { dispatch, actions } = recorder()
    await mcpAdd("--preset github --name gh --GITHUB_PERSONAL_ACCESS_TOKEN ghp_secret", {
      ...base,
      dispatch,
      collectPresets: catalogStub,
      addServer: (name, transport, config) => {
        added = { name, transport, config }
      },
    })
    expect(added).toEqual({
      name: "gh",
      transport: "stdio",
      config: {
        command: "npx",
        args: ["-y", "srv"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
      },
    })
    expect((actions[0] as { message: string }).message).toContain('from preset "github"')
  })

  it("defaults the name to the preset id", async () => {
    let added: { name: string } | null = null
    await mcpAdd("--preset linear-remote", {
      ...base,
      dispatch: () => {},
      collectPresets: catalogStub,
      addServer: (name) => {
        added = { name } as { name: string }
      },
    })
    expect(added!.name).toBe("linear-remote")
  })

  it("reports missing required fields", async () => {
    const { dispatch, actions } = recorder()
    let called = false
    await mcpAdd("--preset github --name gh", {
      ...base,
      dispatch,
      collectPresets: catalogStub,
      addServer: () => {
        called = true
      },
    })
    expect(called).toBe(false)
    expect((actions[0] as { message: string }).message).toContain("--GITHUB_PERSONAL_ACCESS_TOKEN")
  })

  it("reports an unknown preset", async () => {
    const { dispatch, actions } = recorder()
    await mcpAdd("--preset nope", {
      ...base,
      dispatch,
      collectPresets: catalogStub,
      addServer: () => {},
    })
    expect((actions[0] as { message: string }).message).toContain("Unknown preset")
  })
})

// Exercise the REAL default factories (no dep injection) with safe inputs:
// a disabled server (no live connection), a temp home, and the built-in catalog.
describe("real defaults (no injection)", () => {
  let home: string
  beforeEach(() => {
    home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-mcp-"))
  })
  afterEach(() => {
    nodeFs.rmSync(home, { recursive: true, force: true })
  })

  it("mcpList probes a disabled server via the default probe (no connection)", async () => {
    const { dispatch, actions } = recorder()
    await mcpList({ dispatch, roots: [home], home, load: () => [server("off", false)] })
    expect(actions[1]).toMatchObject({
      overlay: { items: [{ id: "off", hint: "stdio · ○ disabled" }] },
    })
  })

  it("mcpAdd writes a server file via the default addServer", async () => {
    const { dispatch } = recorder()
    await mcpAdd("--name fs --transport stdio --command npx", { dispatch, roots: [home], home })
    const doc = JSON.parse(nodeFs.readFileSync(path.join(home, "mcp.json"), "utf8"))
    expect(doc.mcpServers.fs).toEqual({ command: "npx" })
  })

  it("mcpShow reads real auth state for a remote server (default hasTokens)", () => {
    const { dispatch, actions } = recorder()
    const remote = {
      id: "mcp_r",
      name: "r",
      transport: "http",
      enabled: true,
      config: { url: "https://x" },
    } as unknown as McpServer
    mcpShow("r", { dispatch, roots: [home], home, load: () => [remote] })
    expect((actions[0] as { message: string }).message).toContain("auth: not signed in")
  })

  it("mcpLogout reports no credentials via the default store", () => {
    const { dispatch, actions } = recorder()
    mcpLogout("r", { dispatch, roots: [home], home })
    expect((actions[0] as { message: string }).message).toContain("No stored credentials")
  })

  it("mcpPresets renders the real built-in catalog", async () => {
    const { dispatch, actions } = recorder()
    await mcpPresets({ dispatch, roots: [home], home })
    const doc = actions[0] as { overlay: { title: string; body: string } }
    expect(doc.overlay.title).toMatch(/MCP presets \(\d+\)/)
    expect(doc.overlay.body).toContain("GitHub")
  })

  it("mcpAdd --preset instantiates from the real built-in catalog", async () => {
    const { dispatch } = recorder()
    await mcpAdd("--preset deepwiki --name dw", { dispatch, roots: [home], home })
    const doc = JSON.parse(nodeFs.readFileSync(path.join(home, "mcp.json"), "utf8"))
    expect(doc.mcpServers.dw).toEqual({ url: "https://mcp.deepwiki.com/mcp" })
  })

  describe("probeAuthProvider", () => {
    const remote = {
      id: "mcp_r",
      name: "r",
      transport: "http",
      config: { url: "https://x" },
      enabled: true,
    } as unknown as McpServer

    it("returns undefined for stdio servers", () => {
      expect(probeAuthProvider(home, server("s"))).toBeUndefined()
    })
    it("returns undefined for a remote server with no stored tokens", () => {
      expect(probeAuthProvider(home, remote)).toBeUndefined()
    })
    it("returns a token-loading provider for a remote server with stored tokens", () => {
      patchAuthEntry(home, "r", { tokens: { access_token: "t" } })
      const provider = probeAuthProvider(home, remote) as { redirectUrl: string } | undefined
      expect(provider).toBeDefined()
      expect(provider!.redirectUrl).toContain("cognia-mcp-probe")
    })
  })
})
