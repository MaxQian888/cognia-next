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

// Mocked rather than driven through the real store: this file already stubs
// `@/stores/chat`, and the real hook joins that store with the artifact one.
const artifactsBySession: Record<string, { openCount: number; pendingReviewCount: number }> = {}
jest.mock("@/hooks/artifacts/use-session-artifacts", () => ({
  useSessionArtifactSummary: (id: string) =>
    artifactsBySession[id] ?? { openCount: 0, pendingReviewCount: 0 },
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
  for (const k of Object.keys(artifactsBySession)) delete artifactsBySession[k]
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

  // The right rail follows `activeSessionId` alone, so without this an artifact
  // produced by the split pane is entirely invisible — no tab, no dock, no
  // attention signal. The badge is the only thing saying "there is something
  // over there"; selecting the tab is already the way to bring the rail across.
  describe("artifact badge", () => {
    it("counts a background conversation's open artifacts", () => {
      artifactsBySession.b = { openCount: 3, pendingReviewCount: 0 }
      const { getByTestId } = render(<ChatTabStrip {...makeProps()} />)
      const badge = getByTestId("chat-tab-artifacts-b")
      expect(badge.textContent).toContain("3")
      expect(badge).not.toHaveAttribute("data-pending-review")
    })

    it("marks a conversation holding a proposal that wants a decision", () => {
      artifactsBySession.b = { openCount: 2, pendingReviewCount: 1 }
      const { getByTestId } = render(<ChatTabStrip {...makeProps()} />)
      expect(getByTestId("chat-tab-artifacts-b")).toHaveAttribute("data-pending-review", "true")
    })

    // The active tab's artifacts are the ones already on screen in the rail.
    it("stays off the active tab", () => {
      artifactsBySession.a = { openCount: 4, pendingReviewCount: 2 }
      const { queryByTestId } = render(<ChatTabStrip {...makeProps({ activeId: "a" })} />)
      expect(queryByTestId("chat-tab-artifacts-a")).toBeNull()
    })

    it("stays off a conversation holding nothing", () => {
      const { queryByTestId } = render(<ChatTabStrip {...makeProps()} />)
      expect(queryByTestId("chat-tab-artifacts-b")).toBeNull()
    })
  })
})
