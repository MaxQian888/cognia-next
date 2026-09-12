import { handleZhihuCommand } from "./commands"
import { ReviewModal } from "./ui/review-modal"
import { PLUGIN_ID } from "./ids"
import { I18N_MESSAGES } from "./i18n"

// The command module imports the modal, which pulls app hooks; stub it to a
// bare component so this unit test stays focused on command handling.
jest.mock("./ui/review-modal", () => ({ ReviewModal: () => null }))

afterEach(() => jest.clearAllMocks())

describe("handleZhihuCommand", () => {
  it("declines commands that aren't /zhihu", () => {
    const openModal = jest.fn()
    expect(
      handleZhihuCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "not-mine")
    ).toBeNull()
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the review modal and returns a localized PluginCommandResult", () => {
    const openModal = jest.fn()
    const t = jest.fn(() => "OPENED")
    const result = handleZhihuCommand(
      { pluginId: PLUGIN_ID, modal: { openModal }, i18n: { t } } as never,
      "zhihu"
    )
    expect(openModal).toHaveBeenCalledWith(ReviewModal)
    // ctx.i18n.t is the preferred path (host-merged bundle, active locale).
    expect(t).toHaveBeenCalledWith("command.opened")
    expect(result).toEqual({ handled: true, message: "OPENED" })
  })

  it("falls back to the raw bundle when the host i18n registry has no entry", () => {
    const openModal = jest.fn()
    // Host t() echoes the key back on a miss (see createI18nAPI); the handler
    // must then consult getCurrentLocale + the module bundle instead.
    const result = handleZhihuCommand(
      {
        pluginId: PLUGIN_ID,
        modal: { openModal },
        i18n: { t: (k: string) => k, getCurrentLocale: () => "zh-CN" },
      } as never,
      "zhihu"
    )
    expect(result).toEqual({ handled: true, message: I18N_MESSAGES["zh-CN"]["command.opened"] })
  })

  it("falls back to English text with no i18n API at all (bare context)", () => {
    const openModal = jest.fn()
    const result = handleZhihuCommand(
      { pluginId: PLUGIN_ID, modal: { openModal } } as never,
      "zhihu"
    )
    expect(result).toEqual({ handled: true, message: I18N_MESSAGES.en["command.opened"] })
  })

  it("degrades gracefully when no modal API is available", () => {
    const result = handleZhihuCommand({ pluginId: PLUGIN_ID } as never, "zhihu")
    // Still handled so the host doesn't fall through to "command not handled",
    // but nothing is opened and the message explains why.
    expect(result).toEqual({ handled: true, message: I18N_MESSAGES.en["command.noModal"] })
  })
})
