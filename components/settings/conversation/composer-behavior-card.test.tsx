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
})
