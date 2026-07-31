import { vimCommand } from "./vim-command"
import type { CommandContext } from "./types"

const ctx = (args = "", vim?: boolean): CommandContext =>
  ({ args, state: {}, config: { vim }, version: "0" }) as unknown as CommandContext

describe("/vim", () => {
  it("bare toggles relative to the current state", () => {
    expect(vimCommand.handler!(ctx("", undefined))).toEqual({
      kind: "flag",
      key: "vim",
      value: true,
    })
    expect(vimCommand.handler!(ctx("", true))).toEqual({ kind: "flag", key: "vim", value: false })
  })

  it("on/off set explicitly", () => {
    expect(vimCommand.handler!(ctx("on"))).toEqual({ kind: "flag", key: "vim", value: true })
    expect(vimCommand.handler!(ctx("off", true))).toEqual({
      kind: "flag",
      key: "vim",
      value: false,
    })
  })

  it("unknown arg yields a usage notice", () => {
    expect(vimCommand.handler!(ctx("sideways")).kind).toBe("notice")
  })
})
