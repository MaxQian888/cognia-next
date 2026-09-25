import { handleBrowserCommand } from "./commands"
import { PlaywrightSetupModal } from "./ui/setup-modal"

function commandCtx() {
  const openModal = jest.fn()
  const t = jest.fn((key: string) => `t:${key}`)
  return { ctx: { modal: { openModal }, i18n: { t } } as never, openModal, t }
}

describe("handleBrowserCommand", () => {
  it("declines commands it does not own", () => {
    const { ctx, openModal } = commandCtx()
    expect(handleBrowserCommand(ctx, "not-mine")).toBeNull()
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the setup modal and acknowledges in chat via ctx.i18n.t", () => {
    const { ctx, openModal, t } = commandCtx()
    const result = handleBrowserCommand(ctx, "browser")
    expect(t).toHaveBeenCalledWith("command.opened")
    expect(result).toEqual({ handled: true, message: "t:command.opened" })
    expect(openModal).toHaveBeenCalledWith(PlaywrightSetupModal, undefined, { size: "lg" })
  })

  it.each([
    ["isolated", "playwright-isolated"],
    ["extension", "playwright-existing-browser"],
    ["existing", "playwright-existing-browser"],
    ["cdp", "playwright-cdp"],
    ["playwright", "playwright"],
  ])("maps /browser %s to the focused preset card", (arg, presetId) => {
    const { ctx, openModal } = commandCtx()
    handleBrowserCommand(ctx, "browser", [arg])
    expect(openModal).toHaveBeenCalledWith(
      PlaywrightSetupModal,
      { focus: presetId },
      { size: "lg" }
    )
  })

  it("ignores unknown focus args and still opens the guide", () => {
    const { ctx, openModal } = commandCtx()
    handleBrowserCommand(ctx, "browser", ["bogus"])
    expect(openModal).toHaveBeenCalledWith(PlaywrightSetupModal, undefined, { size: "lg" })
  })

  it("lowercases the focus arg before matching", () => {
    const { ctx, openModal } = commandCtx()
    handleBrowserCommand(ctx, "browser", ["CDP"])
    expect(openModal).toHaveBeenCalledWith(
      PlaywrightSetupModal,
      { focus: "playwright-cdp" },
      { size: "lg" }
    )
  })
})
