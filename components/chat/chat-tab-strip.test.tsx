import { render, fireEvent } from "@testing-library/react"
import { ChatTabStrip, type ChatTabInfo } from "./chat-tab-strip"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
}))

const statusBySession: Record<string, string> = {}
jest.mock("@/stores/chat", () => ({
  useSessionStatus: (id: string) => statusBySession[id] ?? "idle",
}))

const tabs: ChatTabInfo[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
  { id: "c", title: "" },
]

function makeProps(over: Partial<Parameters<typeof ChatTabStrip>[0]> = {}) {
  return {
    tabs,
    activeId: "a",
    splitId: null as string | null,
    onSelect: jest.fn(),
    onClose: jest.fn(),
    onToggleSplit: jest.fn(),
    onNew: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  for (const k of Object.keys(statusBySession)) delete statusBySession[k]
})

describe("ChatTabStrip", () => {
  it("renders nothing for a single tab with no split", () => {
    const { container } = render(
      <ChatTabStrip {...makeProps({ tabs: [{ id: "a", title: "A" }] })} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders a tablist with one tab per open session", () => {
    const { getAllByRole, getByRole } = render(<ChatTabStrip {...makeProps()} />)
    expect(getByRole("tablist")).toBeTruthy()
    expect(getAllByRole("tab")).toHaveLength(3)
  })

  it("marks the active tab selected and falls back to 'untitled' for blank titles", () => {
    const { getByTestId } = render(<ChatTabStrip {...makeProps()} />)
    expect(getByTestId("chat-tab-a").getAttribute("aria-selected")).toBe("true")
    expect(getByTestId("chat-tab-b").getAttribute("aria-selected")).toBe("false")
    expect(getByTestId("chat-tab-c").textContent).toContain("untitled")
  })

  it("shows a streaming indicator for a streaming session", () => {
    statusBySession.b = "streaming"
    const { getByLabelText } = render(<ChatTabStrip {...makeProps()} />)
    expect(getByLabelText("streaming")).toBeTruthy()
  })

  it("shows awaiting-approval and error indicators", () => {
    statusBySession.a = "awaiting_approval"
    statusBySession.b = "error"
    const { getByLabelText } = render(<ChatTabStrip {...makeProps()} />)
    expect(getByLabelText("awaitingApproval")).toBeTruthy()
    expect(getByLabelText("errored")).toBeTruthy()
  })

  it("selects a tab on click and on Enter/Space", () => {
    const onSelect = jest.fn()
    const { getByTestId } = render(<ChatTabStrip {...makeProps({ onSelect })} />)
    fireEvent.click(getByTestId("chat-tab-b"))
    expect(onSelect).toHaveBeenCalledWith("b")
    fireEvent.keyDown(getByTestId("chat-tab-c"), { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith("c")
    fireEvent.keyDown(getByTestId("chat-tab-b"), { key: " " })
    expect(onSelect).toHaveBeenCalledTimes(3)
  })

  it("closes a tab without selecting it (stopPropagation)", () => {
    const onClose = jest.fn()
    const onSelect = jest.fn()
    const { getByLabelText } = render(<ChatTabStrip {...makeProps({ onClose, onSelect })} />)
    fireEvent.click(getByLabelText('closeTab:{"title":"Alpha"}'))
    expect(onClose).toHaveBeenCalledWith("a")
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("toggles split for the active tab and shows the new-tab button", () => {
    const onToggleSplit = jest.fn()
    const onNew = jest.fn()
    const { getByLabelText } = render(<ChatTabStrip {...makeProps({ onToggleSplit, onNew })} />)
    fireEvent.click(getByLabelText("splitView"))
    expect(onToggleSplit).toHaveBeenCalledWith("a")
    fireEvent.click(getByLabelText("newTab"))
    expect(onNew).toHaveBeenCalled()
  })

  it("labels the split toggle as exit + pressed when a split is open", () => {
    const { getByLabelText } = render(<ChatTabStrip {...makeProps({ splitId: "b" })} />)
    const btn = getByLabelText("exitSplit")
    expect(btn.getAttribute("aria-pressed")).toBe("true")
  })

  it("still renders (split active) even when reduced to a single tab", () => {
    const { getByRole } = render(
      <ChatTabStrip {...makeProps({ tabs: [{ id: "a", title: "A" }], splitId: "a" })} />
    )
    // splitId forces the strip to render; the split toggle is disabled (canSplit=false).
    expect(getByRole("tablist")).toBeTruthy()
    expect((getByRole("button", { name: "exitSplit" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
