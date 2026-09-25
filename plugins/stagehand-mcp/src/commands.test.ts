import { handleStagehandCommand } from "./commands"
import { StagehandSetupModal } from "./ui/setup-modal"

function commandCtx() {
  const openModal = jest.fn()
  const t = jest.fn((key: string) => `t:${key}`)
  return { ctx: { modal: { openModal }, i18n: { t } } as never, openModal, t }
}

describe("handleStagehandCommand", () => {
  it("declines commands it does not own", () => {
    const { ctx, openModal } = commandCtx()
    expect(handleStagehandCommand(ctx, "not-mine")).toBeNull()
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the setup modal and acknowledges in chat via ctx.i18n.t", () => {
    const { ctx, openModal, t } = commandCtx()
    const result = handleStagehandCommand(ctx, "stagehand")
    expect(t).toHaveBeenCalledWith("command.opened")
    expect(result).toEqual({ handled: true, message: "t:command.opened" })
    expect(openModal).toHaveBeenCalledWith(StagehandSetupModal, undefined, { size: "lg" })
  })

  it.each([
    ["hosted", "stagehand-hosted"],
    ["cloud", "stagehand-hosted"],
    ["local", "stagehand"],
    ["self-hosted", "stagehand"],
    ["stdio", "stagehand"],
    ["stagehand", "stagehand"],
  ])("maps /stagehand %s to the focused preset card", (arg, presetId) => {
    const { ctx, openModal } = commandCtx()
    handleStagehandCommand(ctx, "stagehand", [arg])
    expect(openModal).toHaveBeenCalledWith(StagehandSetupModal, { focus: presetId }, { size: "lg" })
  })

  it("ignores unknown focus args and still opens the guide", () => {
    const { ctx, openModal } = commandCtx()
    handleStagehandCommand(ctx, "stagehand", ["bogus"])
    expect(openModal).toHaveBeenCalledWith(StagehandSetupModal, undefined, { size: "lg" })
  })

  it("lowercases the focus arg before matching", () => {
    const { ctx, openModal } = commandCtx()
    handleStagehandCommand(ctx, "stagehand", ["HOSTED"])
    expect(openModal).toHaveBeenCalledWith(
      StagehandSetupModal,
      { focus: "stagehand-hosted" },
      { size: "lg" }
    )
  })
})
