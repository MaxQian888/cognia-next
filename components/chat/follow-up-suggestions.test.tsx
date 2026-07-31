import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FollowUpSuggestions } from "./follow-up-suggestions"

const mockHook = jest.fn()
jest.mock("@/hooks/chat/use-follow-up-suggestions", () => ({
  useFollowUpSuggestions: () => mockHook(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const session = { id: "s1" } as never

describe("FollowUpSuggestions", () => {
  beforeEach(() => jest.clearAllMocks())

  it("renders nothing when there are no suggestions", () => {
    mockHook.mockReturnValue({ suggestions: [], loading: false, dismiss: jest.fn() })
    const { container } = render(<FollowUpSuggestions session={session} onUseSample={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a chip per suggestion", () => {
    mockHook.mockReturnValue({
      suggestions: ["Tell me more", "Why is that?"],
      loading: false,
      dismiss: jest.fn(),
    })
    render(<FollowUpSuggestions session={session} onUseSample={jest.fn()} />)
    expect(screen.getByText("Tell me more")).toBeInTheDocument()
    expect(screen.getByText("Why is that?")).toBeInTheDocument()
  })

  it("inserts the suggestion and dismisses on click", async () => {
    const user = userEvent.setup()
    const onUseSample = jest.fn()
    const dismiss = jest.fn()
    mockHook.mockReturnValue({ suggestions: ["Do X"], loading: false, dismiss })
    render(<FollowUpSuggestions session={session} onUseSample={onUseSample} />)
    await user.click(screen.getByText("Do X"))
    expect(onUseSample).toHaveBeenCalledWith("Do X")
    expect(dismiss).toHaveBeenCalled()
  })

  it("dismisses all via the close button", async () => {
    const user = userEvent.setup()
    const dismiss = jest.fn()
    mockHook.mockReturnValue({ suggestions: ["Do X"], loading: false, dismiss })
    render(<FollowUpSuggestions session={session} onUseSample={jest.fn()} />)
    await user.click(screen.getByLabelText("dismiss"))
    expect(dismiss).toHaveBeenCalled()
  })
})
