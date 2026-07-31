/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AskUserDialog } from "./ask-user-dialog"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function setActive(request: AskUserRequest, resolve = jest.fn()) {
  useAskUserStore.setState({
    active: { id: "p1", request, resolve },
    queue: [],
  })
  return resolve
}

afterEach(() => useAskUserStore.setState({ active: null, queue: [] }))

const baseRequest = (over: Partial<AskUserRequest> = {}): AskUserRequest => ({
  question: "Pick one",
  options: [
    { value: "a", label: "Apple" },
    { value: "b", label: "Banana" },
  ],
  multiSelect: false,
  allowText: false,
  ...over,
})

describe("AskUserDialog", () => {
  it("renders nothing when no prompt is active", () => {
    useAskUserStore.setState({ active: null, queue: [] })
    const { container } = render(<AskUserDialog />)
    expect(container.querySelector('[data-testid="ask-user-dialog"]')).toBeNull()
  })

  it("shows the question and options", () => {
    setActive(baseRequest())
    render(<AskUserDialog />)
    expect(screen.getByText("Pick one")).toBeInTheDocument()
    expect(screen.getByText("Apple")).toBeInTheDocument()
    expect(screen.getByText("Banana")).toBeInTheDocument()
  })

  it("disables submit until a choice is made, then resolves with the selection", async () => {
    const user = userEvent.setup()
    const resolve = setActive(baseRequest())
    render(<AskUserDialog />)
    const submit = screen.getByRole("button", { name: "submit" })
    expect(submit).toBeDisabled()
    await user.click(screen.getByLabelText("Apple"))
    expect(submit).toBeEnabled()
    await user.click(submit)
    expect(resolve).toHaveBeenCalledWith({ selected: ["a"], text: "", cancelled: false })
  })

  it("supports multi-select via checkboxes", async () => {
    const user = userEvent.setup()
    const resolve = setActive(baseRequest({ multiSelect: true }))
    render(<AskUserDialog />)
    await user.click(screen.getByText("Apple"))
    await user.click(screen.getByText("Banana"))
    await user.click(screen.getByRole("button", { name: "submit" }))
    expect(resolve).toHaveBeenCalledWith({ selected: ["a", "b"], text: "", cancelled: false })
  })

  it("accepts free text when allowText is set", async () => {
    const user = userEvent.setup()
    const resolve = setActive(baseRequest({ options: [], allowText: true }))
    render(<AskUserDialog />)
    await user.type(screen.getByLabelText("textPlaceholder"), "my answer")
    await user.click(screen.getByRole("button", { name: "submit" }))
    expect(resolve).toHaveBeenCalledWith({ selected: [], text: "my answer", cancelled: false })
  })

  it("resolves as cancelled when dismissed", async () => {
    const user = userEvent.setup()
    const resolve = setActive(baseRequest())
    render(<AskUserDialog />)
    await user.click(screen.getByRole("button", { name: "dismiss" }))
    expect(resolve).toHaveBeenCalledWith({ selected: [], text: "", cancelled: true })
  })

  it("submits on Ctrl/Cmd+Enter once a choice is made", async () => {
    const user = userEvent.setup()
    const resolve = setActive(baseRequest())
    render(<AskUserDialog />)
    // Before a selection, the shortcut is a no-op (submit is disabled).
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(resolve).not.toHaveBeenCalled()
    await user.click(screen.getByLabelText("Apple"))
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(resolve).toHaveBeenCalledWith({ selected: ["a"], text: "", cancelled: false })
  })

  it("shows the multi-select hint only when multiSelect is set", () => {
    setActive(baseRequest({ multiSelect: true }))
    const { rerender } = render(<AskUserDialog />)
    expect(screen.getByText("multiHint")).toBeInTheDocument()
    act(() => {
      useAskUserStore.setState({
        active: { id: "p2", request: baseRequest(), resolve: jest.fn() },
        queue: [],
      })
    })
    rerender(<AskUserDialog />)
    expect(screen.queryByText("multiHint")).toBeNull()
  })

  it("surfaces the queued count when other prompts are waiting", () => {
    useAskUserStore.setState({
      active: { id: "p1", request: baseRequest(), resolve: jest.fn() },
      queue: [
        { id: "p2", request: baseRequest(), resolve: jest.fn() },
        { id: "p3", request: baseRequest(), resolve: jest.fn() },
      ],
    })
    render(<AskUserDialog />)
    expect(screen.getByText("queued")).toBeInTheDocument()
  })
})
