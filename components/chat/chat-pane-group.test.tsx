import { render, fireEvent } from "@testing-library/react"
import type { ChatSession } from "@/lib/claude/types"

// ── Mocks ────────────────────────────────────────────────────────────────
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

// Capture ChatPane props per render so we can assert per-pane wiring.
const paneRenders: Array<Record<string, unknown>> = []
jest.mock("./chat-view", () => ({
  ChatPane: (props: Record<string, unknown>) => {
    paneRenders.push(props)
    return <div data-testid={`pane-${(props.sessionId as string) ?? "none"}`} />
  },
}))

const approvalRenders: Array<{ approval: unknown }> = []
jest.mock("./tool-approval-dialog", () => ({
  ToolApprovalDialog: (props: { approval: unknown }) => {
    approvalRenders.push(props)
    return <div data-testid="approval" />
  },
}))

// Resizable primitives → passthrough divs so the split layout renders in jsdom.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="rpg">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="handle" />,
}))

const chatState = {
  activeSessionId: "a" as string | null,
  openSessionIds: ["a", "b"] as string[],
  splitSessionId: null as string | null,
  setActiveSession: jest.fn(),
  setSplitSessionId: jest.fn(),
}
const pendingBySession: Record<string, unknown[]> = {}
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: typeof chatState) => unknown) => sel(chatState),
  useSessionPendingApprovals: (id: string) => pendingBySession[id] ?? [],
  useSessionStatus: () => "idle",
}))

import { ChatPaneGroup } from "./chat-pane-group"

const sessions = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
] as unknown as ChatSession[]

function makeProps(over: Partial<Parameters<typeof ChatPaneGroup>[0]> = {}) {
  return {
    sessions,
    send: jest.fn(),
    stop: jest.fn(),
    steerNow: jest.fn(),
    steerFlush: jest.fn(),
    regenerate: jest.fn(),
    editResend: jest.fn(),
    respondToApproval: jest.fn(),
    closePane: jest.fn(),
    onCreate: jest.fn(),
    onUseSample: jest.fn(),
    onOpenSettings: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  paneRenders.length = 0
  approvalRenders.length = 0
  for (const k of Object.keys(pendingBySession)) delete pendingBySession[k]
  chatState.activeSessionId = "a"
  chatState.openSessionIds = ["a", "b"]
  chatState.splitSessionId = null
  chatState.setActiveSession.mockClear()
  chatState.setSplitSessionId.mockClear()
})

describe("ChatPaneGroup", () => {
  it("renders a single focused pane when not split", () => {
    const { getByTestId, queryByTestId } = render(<ChatPaneGroup {...makeProps()} />)
    expect(getByTestId("pane-a")).toBeTruthy()
    expect(queryByTestId("pane-b")).toBeNull()
    expect(queryByTestId("rpg")).toBeNull()
  })

  it("renders two panes side by side when split is active", () => {
    chatState.splitSessionId = "b"
    const { getByTestId } = render(<ChatPaneGroup {...makeProps()} />)
    expect(getByTestId("rpg")).toBeTruthy()
    expect(getByTestId("pane-a")).toBeTruthy()
    expect(getByTestId("pane-b")).toBeTruthy()
  })

  it("collapses the split when the split session is no longer open", () => {
    chatState.splitSessionId = "gone"
    const { queryByTestId } = render(<ChatPaneGroup {...makeProps()} />)
    expect(queryByTestId("rpg")).toBeNull()
    expect(queryByTestId("pane-a")).toBeTruthy()
  })

  it("wires each pane's send/stop to its own session id", async () => {
    const send = jest.fn()
    const stop = jest.fn()
    chatState.splitSessionId = "b"
    render(<ChatPaneGroup {...makeProps({ send, stop })} />)
    const paneA = paneRenders.find((p) => p.sessionId === "a")!
    const paneB = paneRenders.find((p) => p.sessionId === "b")!
    await (paneA.onSend as (c: unknown) => Promise<void>)("hi-a")
    await (paneB.onSend as (c: unknown) => Promise<void>)("hi-b")
    await (paneB.onStop as () => Promise<void>)()
    expect(send).toHaveBeenCalledWith("hi-a", "a")
    expect(send).toHaveBeenCalledWith("hi-b", "b")
    expect(stop).toHaveBeenCalledWith("b")
  })

  it("wires regenerate + editResend per session", async () => {
    const regenerate = jest.fn()
    const editResend = jest.fn()
    render(<ChatPaneGroup {...makeProps({ regenerate, editResend })} />)
    const paneA = paneRenders.find((p) => p.sessionId === "a")!
    await (paneA.onRegenerate as () => Promise<void>)()
    await (paneA.onEditResend as (id: string, c: unknown) => Promise<void>)("m1", "edited")
    expect(regenerate).toHaveBeenCalledWith("a")
    expect(editResend).toHaveBeenCalledWith("m1", "edited", "a")
  })

  it("renders an inline approval gate scoped to the focused session", () => {
    pendingBySession.a = [{ requestId: "r1", sessionId: "a" }]
    render(<ChatPaneGroup {...makeProps()} />)
    // The focused pane's gate sees its own approval.
    expect(
      approvalRenders.some((r) => (r.approval as { requestId: string })?.requestId === "r1")
    ).toBe(true)
  })

  it("toggles split to a different open session and back", () => {
    const { getByLabelText } = render(<ChatPaneGroup {...makeProps()} />)
    // tab strip is rendered (2 open tabs); clicking split picks the other session.
    fireEvent.click(getByLabelText("splitView"))
    expect(chatState.setSplitSessionId).toHaveBeenCalledWith("b")
  })

  it("exits split when the toggle is pressed while split is open", () => {
    chatState.splitSessionId = "b"
    const { getByLabelText } = render(<ChatPaneGroup {...makeProps()} />)
    fireEvent.click(getByLabelText("exitSplit"))
    expect(chatState.setSplitSessionId).toHaveBeenCalledWith(null)
  })

  it("selecting + closing a tab routes to the store / closePane", () => {
    const closePane = jest.fn()
    const { getByTestId, getAllByLabelText } = render(
      <ChatPaneGroup {...makeProps({ closePane })} />
    )
    fireEvent.click(getByTestId("chat-tab-b"))
    expect(chatState.setActiveSession).toHaveBeenCalledWith("b")
    // Two tabs each expose a close button (i18n interpolation is stubbed); the
    // second corresponds to session "b".
    fireEvent.click(getAllByLabelText("closeTab")[1])
    expect(closePane).toHaveBeenCalledWith("b")
  })
})
