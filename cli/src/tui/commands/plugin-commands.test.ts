import { PLUGIN_COMMANDS } from "./plugin-commands"
import type { CommandContext } from "./types"

const ctx = (args = ""): CommandContext => ({ args }) as unknown as CommandContext

describe("PLUGIN_COMMANDS", () => {
  it("declares the full plugin subcommand surface", () => {
    const sub = (PLUGIN_COMMANDS[0].subcommands ?? []).map((s) => s.name).sort()
    expect(sub).toEqual(
      [
        "disable",
        "enable",
        "install",
        "list",
        "marketplace",
        "reload",
        "show",
        "sources",
        "tools",
        "uninstall",
      ].sort()
    )
  })

  it("routes each subcommand to a plugin runtime effect with the matching action", () => {
    const subs = PLUGIN_COMMANDS[0].subcommands ?? []
    for (const s of subs) {
      expect(s.handler).toBeDefined()
      const effect = s.handler!(ctx()) as {
        kind: string
        runtime?: { feature: string; action: string }
      }
      expect(effect.kind).toBe("runtime")
      expect(effect.runtime?.feature).toBe("plugin")
      expect(effect.runtime?.action).toBe(s.name)
    }
  })

  it("aliases plugins → plugin and defaults to list", () => {
    expect(PLUGIN_COMMANDS[0].aliases).toContain("plugins")
    const effect = PLUGIN_COMMANDS[0].handler!(ctx()) as { runtime?: { action: string } }
    expect(effect.runtime?.action).toBe("list")
  })
})
