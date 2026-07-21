import type { PluginContext } from "@/types/plugin"
import { __resetSlashCommandsForTesting, listCommandsByPlugin } from "@/lib/slash-commands/registry"
import definition from "./index"

function ctx(): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    config: {},
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    agent: { registerTool: jest.fn(), registerSkill: jest.fn() },
  } as unknown as PluginContext
}

beforeEach(() => __resetSlashCommandsForTesting())

describe("manifest", () => {
  it("declares id and capabilities", () => {
    const m = definition.manifest as unknown as { id: string; capabilities: string[] }
    expect(m.id).toBe("cognia-deep-research")
    expect(m.capabilities).toEqual(expect.arrayContaining(["tools", "commands", "skills"]))
  })
})

describe("activate / deactivate", () => {
  it("registers the tool, skill and slash command on activate", () => {
    const c = ctx()
    definition.activate(c)
    const agent = c.agent as unknown as { registerTool: jest.Mock; registerSkill: jest.Mock }
    expect(agent.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "deep_research" })
    )
    expect(agent.registerSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deep-research" })
    )
    // `/research` is DECLARED (manifest.commands[]) and handled by the returned
    // hook — the plugin no longer registers it imperatively, which used to
    // leave a DUPLICATE entry in the registry whose only behaviour was to
    // answer "Plugin command not handled".
    expect(listCommandsByPlugin("cognia-deep-research")).toHaveLength(0)
  })

  it("declares /research and handles it via the returned hook", async () => {
    const c = ctx()
    const hooks = definition.activate(c) as unknown as {
      onCommand?: (cmd: string, args: string[]) => Promise<boolean>
    }
    const commands = (definition.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((x) => x.id)).toEqual(["research"])
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(await hooks?.onCommand?.("research", [])).toBe(true)
  })

  it("removes its slash command on deactivate", () => {
    const c = ctx()
    definition.activate(c)
    definition.deactivate?.()
    expect(listCommandsByPlugin("cognia-deep-research")).toHaveLength(0)
  })
})
