import { BUILT_IN_QUICK_COMMANDS } from "./built-ins"
import { resolveQuickCommand } from "./resolver"
import { isIMQuickCommand } from "./types"

describe("built-in quick commands", () => {
  it("every reserved row is a valid IMQuickCommand under a cognia.* key", () => {
    for (const command of BUILT_IN_QUICK_COMMANDS) {
      expect(isIMQuickCommand(command)).toBe(true)
      expect(command.triggerKey.startsWith("cognia.")).toBe(true)
    }
    expect(BUILT_IN_QUICK_COMMANDS.map((c) => c.triggerKey).sort()).toEqual([
      "cognia.help",
      "cognia.new_task",
      "cognia.open_workbench",
      "cognia.status",
    ])
  })

  it("resolver falls back to built-ins when the adapter has no mapping", () => {
    expect(resolveQuickCommand(undefined, "cognia.new_task")?.action).toEqual({
      type: "slash",
      value: "/new",
    })
    expect(resolveQuickCommand([], "cognia.open_workbench")?.action.type).toBe("link")
    expect(resolveQuickCommand([], "not.reserved")).toBeUndefined()
  })

  it("adapter-configured rows shadow the reserved key", () => {
    const shadowed = resolveQuickCommand(
      [{ triggerKey: "cognia.help", action: { type: "prompt", value: "custom help" } }],
      "cognia.help"
    )
    expect(shadowed?.action).toEqual({ type: "prompt", value: "custom help" })
  })
})
