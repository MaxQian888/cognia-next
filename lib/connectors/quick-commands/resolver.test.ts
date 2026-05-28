import type { IMQuickCommand } from "./types"
import { resolveQuickCommand } from "./resolver"

const commands: IMQuickCommand[] = [
  { triggerKey: "menu.help", label: "Help", action: { type: "prompt", value: "show help" } },
  { triggerKey: "menu.run", action: { type: "slash", value: "/run today" } },
]

describe("resolveQuickCommand", () => {
  it("returns the first command matching by triggerKey", () => {
    expect(resolveQuickCommand(commands, "menu.help")?.label).toBe("Help")
  })

  it("returns undefined when nothing matches", () => {
    expect(resolveQuickCommand(commands, "menu.missing")).toBeUndefined()
  })

  it("returns undefined on empty / undefined list", () => {
    expect(resolveQuickCommand(undefined, "x")).toBeUndefined()
    expect(resolveQuickCommand([], "x")).toBeUndefined()
  })

  it("is case-sensitive (matches Feishu/WeCom wire semantics)", () => {
    expect(resolveQuickCommand(commands, "MENU.HELP")).toBeUndefined()
  })
})
