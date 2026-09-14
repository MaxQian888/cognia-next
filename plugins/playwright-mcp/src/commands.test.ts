import { handleBrowserCommand } from "./commands"
import { PlaywrightSetupModal } from "./ui/setup-modal"
import { I18N_MESSAGES } from "./i18n"

const PLUGIN_ID = "cognia-playwright-mcp"

describe("handleBrowserCommand", () => {
  it("declines commands it does not own", () => {
    const openModal = jest.fn()
    expect(
      handleBrowserCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "not-mine")
    ).toBeNull()
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the setup modal and acknowledges in chat via ctx.i18n.t", () => {
    const openModal = jest.fn()
    const t = jest.fn(() => "opened!")
    const result = handleBrowserCommand(
      { pluginId: PLUGIN_ID, modal: { openModal }, i18n: { t } } as never,
      "browser"
    )
    // ctx.i18n.t is the preferred path (host-merged bundle, active locale).
    expect(t).toHaveBeenCalledWith("command.opened")
    expect(result).toEqual({ handled: true, message: "opened!" })
    expect(openModal).toHaveBeenCalledWith(PlaywrightSetupModal, undefined, { size: "lg" })
  })

  it("falls back to the raw bundle when the host i18n registry has no entry", () => {
    const openModal = jest.fn()
    const result = handleBrowserCommand(
      {
        pluginId: PLUGIN_ID,
        modal: { openModal },
        i18n: { t: (k: string) => k, getCurrentLocale: () => "zh-CN" },
      } as never,
      "browser"
    )
    expect(result).toEqual({
      handled: true,
      message: I18N_MESSAGES["zh-CN"]["command.opened"],
    })
  })

  it("falls back to English text with no i18n API at all (bare context)", () => {
    const openModal = jest.fn()
    const result = handleBrowserCommand(
      { pluginId: PLUGIN_ID, modal: { openModal } } as never,
      "browser"
    )
    expect(result).toEqual({ handled: true, message: I18N_MESSAGES.en["command.opened"] })
  })

  it("reports the no-modal path when the host lacks ctx.modal", () => {
    const result = handleBrowserCommand({ pluginId: PLUGIN_ID } as never, "browser")
    expect(result).toEqual({ handled: true, message: I18N_MESSAGES.en["command.noModal"] })
  })

  it.each([
    ["isolated", "playwright-isolated"],
    ["extension", "playwright-existing-browser"],
    ["existing", "playwright-existing-browser"],
    ["cdp", "playwright-cdp"],
    ["playwright", "playwright"],
  ])("maps /browser %s to the focused preset card", (arg, presetId) => {
    const openModal = jest.fn()
    handleBrowserCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "browser", [arg])
    expect(openModal).toHaveBeenCalledWith(
      PlaywrightSetupModal,
      { focus: presetId },
      { size: "lg" }
    )
  })

  it("ignores unknown focus args and still opens the guide", () => {
    const openModal = jest.fn()
    handleBrowserCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "browser", [
      "bogus",
    ])
    expect(openModal).toHaveBeenCalledWith(PlaywrightSetupModal, undefined, { size: "lg" })
  })

  it("lowercases the focus arg before matching", () => {
    const openModal = jest.fn()
    handleBrowserCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "browser", ["CDP"])
    expect(openModal).toHaveBeenCalledWith(
      PlaywrightSetupModal,
      { focus: "playwright-cdp" },
      { size: "lg" }
    )
  })
})
