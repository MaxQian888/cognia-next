import type { PluginCommandResult, PluginContext } from "@cognia/plugin-sdk"

import definition from "./index"

function ctx(): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    configuration: { getAll: () => ({}) },
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    agent: { registerTool: jest.fn(), registerSkill: jest.fn() },
  } as unknown as PluginContext
}

type CommandHook = (
  command: string,
  args: string[],
  context?: { sessionId?: string }
) => Promise<boolean | PluginCommandResult>

describe("manifest", () => {
  const manifest = definition.manifest as unknown as {
    id: string
    capabilities: string[]
    permissions: string[]
    permissionJustifications?: Record<string, string>
    tools?: Array<{ name: string }>
    networkAccess?: { allowedDomains?: string[]; reasoning?: string }
    configSchema: { properties: Record<string, unknown> }
  }

  it("declares id and capabilities", () => {
    expect(manifest.id).toBe("cognia-deep-research")
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["tools", "commands", "skills", "configuration"])
    )
  })

  it("declares exactly the permissions the public APIs it calls require", () => {
    expect([...manifest.permissions].sort()).toEqual([
      "agent:control",
      "ai:chat",
      "ai:embed",
      "settings:read",
    ])
  })

  it("justifies every permission it asks for", () => {
    for (const permission of manifest.permissions) {
      expect(manifest.permissionJustifications?.[permission]).toBeTruthy()
    }
  })

  it("asks for no direct network access or secrets", () => {
    // Search and page reads run through the host's promoted web tools, so the
    // plugin never opens a socket and never holds a provider key. Declaring
    // either would be asking for reach it does not use.
    expect(manifest.permissions).not.toContain("network:fetch")
    expect(manifest.permissions).not.toContain("secrets:read")
  })

  it("still declares the egress scope the promoted web_fetch is clamped to", () => {
    // `agent:control` is not a blank cheque: `ctx.agent.invokeTool("web_fetch")`
    // is held to this allowlist exactly like `ctx.network` would be. The loop
    // reads whatever the search returns, so the hosts are only known at
    // runtime — `["*"]` is the explicit opt-in, and it requires a public
    // reasoning string the permission-review UI can show.
    expect(manifest.networkAccess?.allowedDomains).toEqual(["*"])
    expect(manifest.networkAccess?.reasoning).toBeTruthy()
  })

  it("keeps no search-provider configuration of its own", () => {
    // The provider and its key live in Settings → Search, once for the app.
    const keys = Object.keys(manifest.configSchema.properties)
    expect(keys).not.toContain("searchProvider")
    expect(keys).not.toContain("exaApiKey")
    expect(keys).not.toContain("tavilyApiKey")
  })

  it("declares the deep_research tool so it is discoverable before activation", () => {
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(["deep_research"])
  })
})

describe("activate", () => {
  it("registers the tool and the skill", () => {
    const c = ctx()
    definition.activate(c)
    const agent = c.agent as unknown as { registerTool: jest.Mock; registerSkill: jest.Mock }
    expect(agent.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "deep_research" })
    )
    expect(agent.registerSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deep-research" })
    )
  })

  it("declares /research and handles it via the returned hook", async () => {
    const c = ctx()
    const hooks = definition.activate(c) as unknown as { onCommand?: CommandHook }
    const commands = (definition.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((x) => x.id)).toEqual(["research"])
    // Declining another plugin's command must be a plain `false` so the host
    // keeps looking, not a handled-with-no-message result.
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
  })

  it("answers into the chat instead of a toast", async () => {
    // A multi-page cited report in a transient popup is unreadable and
    // unscrollable; the command's own `message` is what puts it in the
    // conversation.
    const c = ctx()
    const hooks = definition.activate(c) as unknown as { onCommand?: CommandHook }
    const result = (await hooks?.onCommand?.("research", [], {
      sessionId: "s-1",
    })) as PluginCommandResult
    expect(result.handled).toBe(true)
    expect(result.message).toMatch(/Usage/)
    // No UI namespace is touched at all — there is no toast path left.
    expect((c as unknown as { ui?: unknown }).ui).toBeUndefined()
  })
})
