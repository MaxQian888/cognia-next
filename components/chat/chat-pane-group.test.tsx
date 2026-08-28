import { render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

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
  it("does not render a duplicate conversation tab strip", () => {
    chatState.openSessionIds = ["a", "b"]
    render(<ChatPaneGroup {...makeProps()} />)
    expect(screen.queryByRole("tablist")).toBeNull()
  })

  it("renders a single focused pane when not split", () => {
    const { getByTestId, queryByTestId } = render(<ChatPaneGroup {...makeProps()} />)
    expect(getByTestId("pane-a")).toBeTruthy()
    expect(queryByTestId("pane-b")).toBeNull()
    expect(queryByTestId("rpg")).toBeNull()
  })

  it("disables the composer in every pane while keeping conversation panes mounted", () => {
    chatState.splitSessionId = "b"
    render(<ChatPaneGroup {...makeProps({ composerDisabled: true })} />)

    expect(paneRenders).toHaveLength(2)
    expect(paneRenders.every((pane) => pane.composerDisabled === true)).toBe(true)
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
    // Attachment manifest, template provenance, and pre-dispatch metadata are
    // all forwarded verbatim; all are undefined for these bare text turns.
    expect(send).toHaveBeenCalledWith("hi-a", "a", undefined, undefined, undefined)
    expect(send).toHaveBeenCalledWith("hi-b", "b", undefined, undefined, undefined)
    expect(stop).toHaveBeenCalledWith("b")
  })

  it("forwards the composer's attachment manifest through to the pane's session", async () => {
    const send = jest.fn()
    render(<ChatPaneGroup {...makeProps({ send })} />)
    const pane = paneRenders.find((p) => p.sessionId === "a")!
    const manifest = [{ filename: "a.pdf", mediaType: "application/pdf", kind: "document" }]
    await (pane.onSend as (c: unknown, m: unknown) => Promise<void>)("hi", manifest)
    expect(send).toHaveBeenCalledWith("hi", "a", manifest, undefined, undefined)
  })

  // The values are what make a turn re-runnable: the sent text has them
  // substituted in and no longer marks which words they were.
  it("forwards the template run a turn was written from", async () => {
    const send = jest.fn()
    render(<ChatPaneGroup {...makeProps({ send })} />)
    const pane = paneRenders.find((p) => p.sessionId === "a")!
    const run = {
      templateId: "tpl",
      version: "1",
      text: "review {{module}}",
      params: { module: { kind: "text", value: "auth" } },
    }
    await (pane.onSend as (c: unknown, m: unknown, r: unknown) => Promise<void>)(
      "review auth",
      undefined,
      run
    )
    expect(send).toHaveBeenCalledWith("review auth", "a", undefined, run, undefined)
  })

  it("forwards web-search sources before the pane dispatches", async () => {
    const send = jest.fn()
    render(<ChatPaneGroup {...makeProps({ send })} />)
    const pane = paneRenders.find((p) => p.sessionId === "a")!
    const metadata = {
      webSearchContext: {
        provider: "tavily",
        results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
      },
    }
    await (pane.onSend as (...args: unknown[]) => Promise<void>)(
      "question",
      undefined,
      null,
      metadata
    )
    expect(send).toHaveBeenCalledWith("question", "a", undefined, null, metadata)
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

  it("keeps a compact exit action when split view is open", () => {
    chatState.splitSessionId = "b"
    render(<ChatPaneGroup {...makeProps()} />)
    const splitPane = paneRenders.find((pane) => pane.sessionId === "b")!
    ;(splitPane.onExitSplit as () => void)()
    expect(chatState.setSplitSessionId).toHaveBeenCalledWith(null)
  })

  it("keeps a compact split action when another conversation is open", () => {
    render(<ChatPaneGroup {...makeProps()} />)
    const activePane = paneRenders.find((pane) => pane.sessionId === "a")!
    ;(activePane.onSplitView as () => void)()
    expect(chatState.setSplitSessionId).toHaveBeenCalledWith("b")
  })
  describe("cross-workspace split is refused, not silently co-rendered", () => {
    // Artifacts, terminals, source control and the workspace panel all resolve
    // against ONE active workspace, so a second pane from another project would
    // render a conversation whose surroundings describe a different repository.
    const crossWorkspace = [
      { id: "a", title: "Alpha", projectId: "project-a" },
      { id: "b", title: "Beta", projectId: "project-b" },
    ] as unknown as ChatSession[]

    it("offers no split target when the only other open conversation is elsewhere", () => {
      render(<ChatPaneGroup {...makeProps({ sessions: crossWorkspace })} />)
      expect(paneRenders.at(-1)?.onSplitView).toBeUndefined()
    })

    it("still offers a split target within the same workspace", () => {
      const sameWorkspace = [
        { id: "a", title: "Alpha", projectId: "project-a" },
        { id: "b", title: "Beta", projectId: "project-a" },
      ] as unknown as ChatSession[]
      render(<ChatPaneGroup {...makeProps({ sessions: sameWorkspace })} />)
      expect(paneRenders.at(-1)?.onSplitView).toBeInstanceOf(Function)
    })

    it("collapses an existing split once the panes no longer share a workspace", () => {
      chatState.splitSessionId = "b"
      render(<ChatPaneGroup {...makeProps({ sessions: crossWorkspace })} />)
      expect(screen.queryByTestId("rpg")).not.toBeInTheDocument()
      expect(screen.getByTestId("pane-a")).toBeInTheDocument()
      expect(screen.queryByTestId("pane-b")).not.toBeInTheDocument()
    })
  })
})
