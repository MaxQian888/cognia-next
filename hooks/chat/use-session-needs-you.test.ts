/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useAskUserStore } from "@/stores/agent/ask-user-store"
import { useExternalElicitationStore } from "@/stores/agent/external-elicitation-store"
import { useSessionMessages, useSessionPendingApprovals } from "@/stores/chat"

import { useSessionNeedsYou } from "./use-session-needs-you"

jest.mock("@/stores/chat", () => ({
  useSessionPendingApprovals: jest.fn(() => []),
  useSessionMessages: jest.fn(() => []),
}))

const question = (id: string, sessionId: string | undefined, text: string) => ({
  id,
  sessionId,
  request: { question: text, options: [], multiSelect: false, allowText: true },
  resolve: jest.fn(),
})

beforeEach(() => {
  jest.mocked(useSessionPendingApprovals).mockReturnValue([])
  jest.mocked(useSessionMessages).mockReturnValue([])
  useAskUserStore.setState({ active: null, queue: [] })
  useExternalElicitationStore.setState({ bySession: {} })
})

it("lists approvals, this session's questions and elicitations in that order", () => {
  jest.mocked(useSessionPendingApprovals).mockReturnValue([
    { requestId: "a1", toolName: "Bash", displayName: "Run command", status: "pending" },
    { requestId: "a2", toolName: "Write", status: "interrupted" },
    { requestId: "a3", toolName: "Edit", title: "Edit app.ts" },
  ] as never)
  useAskUserStore.setState({
    active: question("q1", "other", "Not mine"),
    queue: [question("q2", "s1", "Which branch?")],
  })
  useExternalElicitationStore.setState({
    bySession: { s1: [{ request: { id: "e1", message: "Sign in to continue" } }] },
  } as never)

  const { result } = renderHook(() => useSessionNeedsYou("s1"))

  expect(result.current.items).toEqual([
    { kind: "approval", id: "a1", label: "Run command" },
    { kind: "approval", id: "a3", label: "Edit app.ts" },
    { kind: "question", id: "q2", label: "Which branch?" },
    { kind: "elicitation", id: "e1", label: "Sign in to continue" },
  ])
})

it("falls back to the tool name when an approval has no title", () => {
  jest
    .mocked(useSessionPendingApprovals)
    .mockReturnValue([{ requestId: "a1", toolName: "Bash" }] as never)
  const { result } = renderHook(() => useSessionNeedsYou("s1"))
  expect(result.current.items[0].label).toBe("Bash")
})

it("points the jump at the latest assistant message", () => {
  jest.mocked(useSessionMessages).mockReturnValue([
    { id: "u1", role: "user", parts: [] },
    { id: "a1", role: "assistant", parts: [] },
    { id: "u2", role: "user", parts: [] },
  ] as never)
  const { result } = renderHook(() => useSessionNeedsYou("s1"))
  expect(result.current.jumpMessageId).toBe("a1")
})

it("has no jump target before the assistant has replied", () => {
  const { result } = renderHook(() => useSessionNeedsYou("s1"))
  expect(result.current).toEqual({ items: [], jumpMessageId: null })
})

it("updates when a question for the session is queued", () => {
  const { result } = renderHook(() => useSessionNeedsYou("s1"))
  expect(result.current.items).toEqual([])
  act(() => useAskUserStore.setState({ active: question("q1", "s1", "Proceed?") }))
  expect(result.current.items).toEqual([{ kind: "question", id: "q1", label: "Proceed?" }])
})
