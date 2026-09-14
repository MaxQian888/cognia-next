import { handleStagehandCommand } from "./commands"
import { StagehandSetupModal } from "./ui/setup-modal"
import { I18N_MESSAGES } from "./i18n"

const PLUGIN_ID = "cognia-stagehand-mcp"

describe("handleStagehandCommand", () => {
  it("declines commands it does not own", () => {
    const openModal = jest.fn()
    expect(
      handleStagehandCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "not-mine")
    ).toBeNull()
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the setup modal and acknowledges in chat via ctx.i18n.t", () => {
    const openModal = jest.fn()
    const t = jest.fn(() => "opened!")
    const result = handleStagehandCommand(
      { pluginId: PLUGIN_ID, modal: { openModal }, i18n: { t } } as never,
      "stagehand"
    )
    // ctx.i18n.t is the preferred path (host-merged bundle, active locale).
    expect(t).toHaveBeenCalledWith("command.opened")
    expect(result).toEqual({ handled: true, message: "opened!" })
    expect(openModal).toHaveBeenCalledWith(StagehandSetupModal, undefined, { size: "lg" })
  })

  it("falls back to the raw bundle when the host i18n registry has no entry", () => {
    const openModal = jest.fn()
    const result = handleStagehandCommand(
      {
        pluginId: PLUGIN_ID,
        modal: { openModal },
        i18n: { t: (k: string) => k, getCurrentLocale: () => "zh-CN" },
      } as never,
      "stagehand"
    )
    expect(result).toEqual({
      handled: true,
      message: I18N_MESSAGES["zh-CN"]["command.opened"],
    })
  })

  it("falls back to English text with no i18n API at all (bare context)", () => {
    const openModal = jest.fn()
    const result = handleStagehandCommand(
      { pluginId: PLUGIN_ID, modal: { openModal } } as never,
      "stagehand"
    )
    expect(result).toEqual({ handled: true, message: I18N_MESSAGES.en["command.opened"] })
  })

  it("reports the no-modal path when the host lacks ctx.modal", () => {
    const result = handleStagehandCommand({ pluginId: PLUGIN_ID } as never, "stagehand")
    expect(result).toEqual({ handled: true, message: I18N_MESSAGES.en["command.noModal"] })
  })

  it.each([
    ["hosted", "stagehand-hosted"],
    ["cloud", "stagehand-hosted"],
    ["local", "stagehand"],
    ["self-hosted", "stagehand"],
    ["stdio", "stagehand"],
    ["stagehand", "stagehand"],
  ])("maps /stagehand %s to the focused preset card", (arg, presetId) => {
    const openModal = jest.fn()
    handleStagehandCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "stagehand", [
      arg,
    ])
    expect(openModal).toHaveBeenCalledWith(StagehandSetupModal, { focus: presetId }, { size: "lg" })
  })

  it("ignores unknown focus args and still opens the guide", () => {
    const openModal = jest.fn()
    handleStagehandCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "stagehand", [
      "bogus",
    ])
    expect(openModal).toHaveBeenCalledWith(StagehandSetupModal, undefined, { size: "lg" })
  })

  it("lowercases the focus arg before matching", () => {
    const openModal = jest.fn()
    handleStagehandCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "stagehand", [
      "HOSTED",
    ])
    expect(openModal).toHaveBeenCalledWith(
      StagehandSetupModal,
      { focus: "stagehand-hosted" },
      { size: "lg" }
    )
  })
})
