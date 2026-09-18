import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InlineQuestionsCard } from "./inline-questions-card"

const save = jest.fn()
let mockSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings, save }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

describe("InlineQuestionsCard", () => {
  beforeEach(() => {
    save.mockReset()
    mockSettings = {}
  })

  it("is off by default — the card UI is opt-in", () => {
    render(<InlineQuestionsCard />)
    expect(screen.getByLabelText("enabled.label")).not.toBeChecked()
  })

  it("reflects the persisted flag", () => {
    mockSettings = { inlineQuestions: { enabled: true } }
    render(<InlineQuestionsCard />)
    expect(screen.getByLabelText("enabled.label")).toBeChecked()
  })

  it("writes the flag through the settings save", async () => {
    const user = userEvent.setup()
    render(<InlineQuestionsCard />)
    await user.click(screen.getByLabelText("enabled.label"))
    expect(save).toHaveBeenCalledWith({ inlineQuestions: { enabled: true } })
  })

  it("toggles off without disturbing a sibling key in the block", async () => {
    const user = userEvent.setup()
    mockSettings = { inlineQuestions: { enabled: true } }
    render(<InlineQuestionsCard />)
    await user.click(screen.getByLabelText("enabled.label"))
    expect(save).toHaveBeenCalledWith({ inlineQuestions: { enabled: false } })
  })
})
