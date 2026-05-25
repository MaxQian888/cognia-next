import { resolveQuickCommand, type LarkQuickCommand } from "./quick-commands"

const cmds: LarkQuickCommand[] = [
  { eventKey: "agenda", label: "今日日程", action: { type: "slash", value: "/agenda today" } },
  { eventKey: "summary", action: { type: "prompt", value: "Summarize my unread." } },
]

describe("resolveQuickCommand", () => {
  it("returns the matching command by eventKey", () => {
    expect(resolveQuickCommand(cmds, "agenda")?.action.value).toBe("/agenda today")
    expect(resolveQuickCommand(cmds, "summary")?.action.type).toBe("prompt")
  })

  it("returns undefined for an unknown eventKey", () => {
    expect(resolveQuickCommand(cmds, "missing")).toBeUndefined()
  })

  it("returns undefined for empty/absent command lists", () => {
    expect(resolveQuickCommand(undefined, "agenda")).toBeUndefined()
    expect(resolveQuickCommand([], "agenda")).toBeUndefined()
  })
})
