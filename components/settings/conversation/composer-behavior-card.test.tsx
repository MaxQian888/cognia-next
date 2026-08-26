import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ComposerBehaviorCard } from "./composer-behavior-card"

const save = jest.fn()
let mockSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings, save }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

describe("ComposerBehaviorCard", () => {
  beforeEach(() => {
    save.mockReset()
    mockSettings = { composerBehavior: {} }
  })

  it("defaults all five toggles ON when the block is empty", () => {
    render(<ComposerBehaviorCard />)
    expect(screen.getByLabelText("sendOnEnter.label")).toBeChecked()
    expect(screen.getByLabelText("clearAfterSend.label")).toBeChecked()
    expect(screen.getByLabelText("autoScroll.label")).toBeChecked()
    expect(screen.getByLabelText("inputHistory.label")).toBeChecked()
    expect(screen.getByLabelText("persistDrafts.label")).toBeChecked()
  })

  it("keeps the compact composer opt-in and persists the selection", async () => {
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)

    const compactLayout = screen.getByLabelText("compactLayout.label")
    expect(compactLayout).not.toBeChecked()

    await user.click(compactLayout)
    expect(save).toHaveBeenCalledWith({ composerBehavior: { compactLayout: true } })
  })

  it("turns a persisted compact composer off without losing sibling behavior", async () => {
    mockSettings = { composerBehavior: { compactLayout: true, sendOnEnter: false } }
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)

    const compactLayout = screen.getByLabelText("compactLayout.label")
    expect(compactLayout).toBeChecked()

    await user.click(compactLayout)
    expect(save).toHaveBeenCalledWith({
      composerBehavior: { compactLayout: false, sendOnEnter: false },
    })
  })

  it("toggles sendOnEnter off and merges into the block", async () => {
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)
    await user.click(screen.getByLabelText("sendOnEnter.label"))
    expect(save).toHaveBeenCalledWith({ composerBehavior: { sendOnEnter: false } })
  })

  it("toggles clearAfterSend off", async () => {
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)
    await user.click(screen.getByLabelText("clearAfterSend.label"))
    expect(save).toHaveBeenCalledWith({ composerBehavior: { clearAfterSend: false } })
  })

  it("toggles autoScroll off", async () => {
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)
    await user.click(screen.getByLabelText("autoScroll.label"))
    expect(save).toHaveBeenCalledWith({ composerBehavior: { autoScrollOnStream: false } })
  })

  it("toggles inputHistory off", async () => {
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)
    await user.click(screen.getByLabelText("inputHistory.label"))
    expect(save).toHaveBeenCalledWith({ composerBehavior: { inputHistoryRecall: false } })
  })

  it("toggles persistDrafts off", async () => {
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)
    await user.click(screen.getByLabelText("persistDrafts.label"))
    expect(save).toHaveBeenCalledWith({ composerBehavior: { persistDrafts: false } })
  })

  it("re-enables a persisted-off toggle while preserving sibling state", async () => {
    mockSettings = { composerBehavior: { sendOnEnter: false, persistDrafts: false } }
    const user = userEvent.setup()
    render(<ComposerBehaviorCard />)
    expect(screen.getByLabelText("sendOnEnter.label")).not.toBeChecked()
    expect(screen.getByLabelText("persistDrafts.label")).not.toBeChecked()
    await user.click(screen.getByLabelText("sendOnEnter.label"))
    expect(save).toHaveBeenCalledWith({
      composerBehavior: { sendOnEnter: true, persistDrafts: false },
    })
  })

  it("works with no composerBehavior block at all", () => {
    mockSettings = {}
    render(<ComposerBehaviorCard />)
    expect(screen.getByLabelText("autoScroll.label")).toBeChecked()
  })

  describe("thinking-level presentation", () => {
    it("shows the slider as the default when nothing is persisted", () => {
      render(<ComposerBehaviorCard />)
      expect(screen.getByLabelText("effortSelectorMode.label")).toBeChecked()
    })

    it("switches the composer control to the list presentation", async () => {
      const user = userEvent.setup()
      render(<ComposerBehaviorCard />)
      await user.click(screen.getByLabelText("effortSelectorMode.label"))
      expect(save).toHaveBeenCalledWith({ composerBehavior: { effortSelectorMode: "list" } })
    })

    it("reflects a persisted list preference and switches back", async () => {
      mockSettings = { composerBehavior: { effortSelectorMode: "list", persistDrafts: false } }
      const user = userEvent.setup()
      render(<ComposerBehaviorCard />)
      const toggle = screen.getByLabelText("effortSelectorMode.label")
      expect(toggle).not.toBeChecked()

      await user.click(toggle)
      expect(save).toHaveBeenCalledWith({
        composerBehavior: { effortSelectorMode: "slider", persistDrafts: false },
      })
    })
  })

  describe("link chips", () => {
    it("saves a shortening rule list typed as text, on blur", async () => {
      const user = userEvent.setup()
      render(<ComposerBehaviorCard />)

      const rules = screen.getByLabelText("linkChips.rulesLabel")
      await user.click(rules)
      await user.paste("wiki.corp.example = https://wiki.corp.example/display/")
      await user.tab()

      expect(save).toHaveBeenCalledWith({
        composerBehavior: {
          linkChips: {
            rules: [{ host: "wiki.corp.example", strip: "https://wiki.corp.example/display/" }],
          },
        },
      })
    })

    it("does not save when blurring an unchanged rule list", async () => {
      mockSettings = { composerBehavior: { linkChips: { rules: [{ host: "x.dev" }] } } }
      const user = userEvent.setup()
      render(<ComposerBehaviorCard />)

      await user.click(screen.getByLabelText("linkChips.rulesLabel"))
      await user.tab()
      expect(save).not.toHaveBeenCalled()
    })

    it("seeds the field from the saved rules", () => {
      mockSettings = {
        composerBehavior: { linkChips: { rules: [{ host: "x.dev", strip: "https://x.dev/" }] } },
      }
      render(<ComposerBehaviorCard />)
      expect(screen.getByLabelText("linkChips.rulesLabel")).toHaveValue("x.dev = https://x.dev/")
    })
  })
})
