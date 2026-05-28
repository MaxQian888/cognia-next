import { resolveQuickCommand, type LarkQuickCommand } from "./quick-commands"
import { normalizeQuickCommandList } from "@/lib/connectors/quick-commands"

const cmds: LarkQuickCommand[] = [
  { triggerKey: "agenda", label: "今日日程", action: { type: "slash", value: "/agenda today" } },
  { triggerKey: "summary", action: { type: "prompt", value: "Summarize my unread." } },
]

describe("resolveQuickCommand", () => {
  it("returns the matching command by triggerKey", () => {
    expect(resolveQuickCommand(cmds, "agenda")?.action.value).toBe("/agenda today")
    expect(resolveQuickCommand(cmds, "summary")?.action.type).toBe("prompt")
  })

  it("returns undefined for an unknown triggerKey", () => {
    expect(resolveQuickCommand(cmds, "missing")).toBeUndefined()
  })

  it("returns undefined for empty/absent command lists", () => {
    expect(resolveQuickCommand(undefined, "agenda")).toBeUndefined()
    expect(resolveQuickCommand([], "agenda")).toBeUndefined()
  })

  it("matches legacy persisted rows once they are normalised", () => {
    // Legacy Lark adapter rows pre-dated the cross-adapter rename. The
    // createLarkAdapter factory normalises on read so the lookup path
    // sees `triggerKey` regardless of which shape Dexie holds.
    const legacy = normalizeQuickCommandList([
      { eventKey: "agenda", action: { type: "slash", value: "/agenda today" } },
    ])
    expect(resolveQuickCommand(legacy, "agenda")?.action.value).toBe("/agenda today")
  })
})
