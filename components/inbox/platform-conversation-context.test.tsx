/** @jest-environment jsdom */
import { Activity } from "react"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import {
  useActiveConversationStore,
  isViewingConversation,
} from "@/stores/inbox/active-conversation-store"
import { useUnreadMarkerStore } from "@/stores/chat/unread-marker-store"
import type { ChatSession } from "@cognia/agent-config-types"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
let mockAdapter: AdapterInstanceRow | undefined
let mockReadState: { sessionId: string; lastReadAt: number; unreadCount: number } | undefined
const mockGetState = jest.fn(async (_sessionId: string) => mockReadState)
const mockMarkRead = jest.fn(async (sessionId: string) => {
  mockReadState = { sessionId, lastReadAt: 200, unreadCount: 0 }
})
const mockHistory = jest.fn()
const mockHeader = jest.fn()
jest.mock("@/hooks/connectors/use-adapter-instance", () => ({
  useAdapterInstance: () => mockAdapter,
}))
jest.mock("@/hooks/connectors/use-resolved-binding", () => ({
  useResolvedBinding: () => ({ trigger: { rules: [] } }),
}))
jest.mock("@/lib/db/session-state", () => ({
  getSessionState: (sessionId: string) => mockGetState(sessionId),
  markSessionRead: (sessionId: string) => mockMarkRead(sessionId),
}))
jest.mock("./conversation-header", () => ({
  ConversationHeader: (props: unknown) => {
    mockHeader(props)
    return <div data-testid="controls" />
  },
}))
jest.mock("./history-load-earlier", () => ({
  HistoryLoadEarlier: (props: unknown) => {
    mockHistory(props)
    return <div data-testid="history" />
  },
}))
jest.mock("./notices/notice-area", () => ({
  InboxNoticeArea: ({ conversationKey }: { conversationKey: string }) => (
    <div data-testid="notices">{conversationKey}</div>
  ),
}))
jest.mock("./thread-membership-chip", () => ({
  ThreadMembershipChip: () => <div data-testid="thread" />,
}))
import {
  PlatformConversationContext,
  PlatformConversationHeader,
} from "./platform-conversation-context"
const session: ChatSession = {
  id: "s1",
  title: "Group",
  kind: "direct",
  createdAt: 1,
  updatedAt: 1,
  platformBinding: {
    platform: "slack",
    adapterId: "a1",
    conversationKey: "slack:a1:C1",
    conversationRef: { platform: "slack", adapterId: "a1" },
  },
}
beforeEach(() => {
  jest.clearAllMocks()
  mockReadState = undefined
  useUnreadMarkerStore.setState({ markers: {} })
  useActiveConversationStore.setState({
    activeConversationKey: null,
    activeSessionId: null,
    visiblePanes: {},
  })
  jest.spyOn(document, "hasFocus").mockReturnValue(true)
  mockAdapter = undefined
})
it("shows platform controls on hosts without a chat header and preserves notices/history", async () => {
  const { unmount } = render(<PlatformConversationContext session={session} showHeader />)
  expect(screen.getByTestId("controls")).toBeInTheDocument()
  expect(screen.getByTestId("notices")).toHaveTextContent("slack:a1:C1")
  expect(mockHeader).toHaveBeenCalledWith(
    expect.objectContaining({ controlsOnly: true, sessionId: "s1" })
  )
  expect(mockHistory).toHaveBeenCalledWith(expect.objectContaining({ unavailable: undefined }))
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(true)
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith("s1"))
  unmount()
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(false)
})
it("keeps history visible with a missing-scope explanation", () => {
  mockAdapter = {
    id: "a1",
    type: "slack",
    settings: { connectedScopes: { scopes: ["chat:write"], grantedAtMs: 1 } },
  } as unknown as AdapterInstanceRow
  render(<PlatformConversationContext session={session} />)
  expect(screen.getByTestId("history")).toBeInTheDocument()
  expect(mockHistory).toHaveBeenCalledWith(
    expect.objectContaining({ unavailable: expect.objectContaining({ available: false }) })
  )
  expect(screen.queryByTestId("controls")).not.toBeInTheDocument()
})
it("keeps unsupported history visible and recognizes an embedded pane as viewed", () => {
  render(
    <PlatformConversationContext
      session={{
        ...session,
        platformBinding: { ...session.platformBinding!, platform: "telegram" },
      }}
    />
  )
  expect(mockHistory).toHaveBeenCalledWith(
    expect.objectContaining({ unavailable: expect.objectContaining({ available: false }) })
  )
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(true)
})
it("shows adapter account identity beside thread and platform controls", () => {
  mockAdapter = { displayName: "Support bot" } as AdapterInstanceRow
  render(<PlatformConversationHeader session={session} />)
  expect(screen.getByText("Support bot")).toHaveAttribute("title", "slack:a1:C1")
  expect(screen.getByTestId("thread")).toBeInTheDocument()
})
it("has no platform surface for a local conversation", () => {
  const local = { ...session, platformBinding: undefined }
  const { container } = render(
    <>
      <PlatformConversationContext session={local} />
      <PlatformConversationHeader session={local} />
    </>
  )
  expect(container).toBeEmptyDOMElement()
  expect(mockMarkRead).not.toHaveBeenCalled()
})

it("keeps a duplicate visible session registered after its sibling closes", async () => {
  const first = render(<PlatformConversationContext session={session} />)
  const second = render(<PlatformConversationContext session={session} />)
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledTimes(1))
  first.unmount()
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(true)
  second.unmount()
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(false)
})

it("marks existing unread on focus return and stops after the pane unmounts", async () => {
  jest.spyOn(document, "hasFocus").mockReturnValue(false)
  const pane = render(<PlatformConversationContext session={session} />)
  expect(mockMarkRead).not.toHaveBeenCalled()
  jest.spyOn(document, "hasFocus").mockReturnValue(true)
  fireEvent.focus(window)
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledTimes(1))
  pane.unmount()
  fireEvent.focus(window)
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledTimes(1))
})

it("releases hidden Activity panels and marks read when they become visible again", async () => {
  const pane = render(
    <Activity mode="visible">
      <PlatformConversationContext session={session} />
    </Activity>
  )
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(true)
  pane.rerender(
    <Activity mode="hidden">
      <PlatformConversationContext session={session} />
    </Activity>
  )
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(false)
  mockMarkRead.mockClear()
  fireEvent.focus(window)
  expect(mockMarkRead).not.toHaveBeenCalled()
  pane.rerender(
    <Activity mode="visible">
      <PlatformConversationContext session={session} />
    </Activity>
  )
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith("s1"))
})

it("moves read tracking to the new session and forwards exact history identity", () => {
  const pane = render(<PlatformConversationContext session={session} />)
  pane.rerender(<PlatformConversationContext session={{ ...session, id: "s2" }} />)
  expect(isViewingConversation("slack:a1:C1", "s1")).toBe(false)
  expect(isViewingConversation("slack:a1:C1", "s2")).toBe(true)
  expect(mockHistory).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s2" }))
})

it("retries read reconciliation after a failed write on the next focus", async () => {
  const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  mockMarkRead.mockRejectedValueOnce(new Error("temporarily unavailable"))
  render(<PlatformConversationContext session={session} />)
  await waitFor(() => expect(warning).toHaveBeenCalled())
  fireEvent.focus(window)
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledTimes(2))
  warning.mockRestore()
})

it("waits until a hidden document becomes visible", async () => {
  const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  render(<PlatformConversationContext session={session} />)
  expect(mockMarkRead).not.toHaveBeenCalled()
  visibility.mockReturnValue("visible")
  fireEvent(document, new Event("visibilitychange"))
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith("s1"))
  visibility.mockRestore()
})

it("preserves the real unread divider on refocus and duplicate-owner takeover", async () => {
  mockReadState = { sessionId: "s1", lastReadAt: 100, unreadCount: 3 }
  const first = render(<PlatformConversationContext session={session} />)
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledTimes(1))
  expect(useUnreadMarkerStore.getState().markers.s1).toBe(100)
  const duplicate = render(<PlatformConversationContext session={session} />)
  await act(async () => {
    fireEvent.focus(window)
  })
  expect(useUnreadMarkerStore.getState().markers.s1).toBe(100)
  expect(mockGetState).toHaveBeenCalledTimes(1)
  first.unmount()
  mockReadState = { sessionId: "s1", lastReadAt: 200, unreadCount: 2 }
  await act(async () => {
    fireEvent.focus(window)
  })
  expect(mockReadState.unreadCount).toBe(0)
  expect(useUnreadMarkerStore.getState().markers.s1).toBe(100)
  expect(mockGetState).toHaveBeenCalledTimes(1)
  duplicate.unmount()
  mockReadState = { sessionId: "s1", lastReadAt: 300, unreadCount: 1 }
  render(<PlatformConversationContext session={session} />)
  await waitFor(() => expect(useUnreadMarkerStore.getState().markers.s1).toBe(300))
  expect(mockGetState).toHaveBeenCalledTimes(2)
})

it("retries an initial failed marker capture before acknowledging unread", async () => {
  const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  mockReadState = { sessionId: "s1", lastReadAt: 100, unreadCount: 3 }
  mockGetState.mockRejectedValueOnce(new Error("read failed"))
  render(<PlatformConversationContext session={session} />)
  await waitFor(() => expect(warning).toHaveBeenCalled())
  expect(mockMarkRead).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.focus(window)
  })
  expect(useUnreadMarkerStore.getState().markers.s1).toBe(100)
  expect(mockMarkRead).toHaveBeenCalledTimes(1)
  warning.mockRestore()
})
