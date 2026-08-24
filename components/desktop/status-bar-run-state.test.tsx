/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))

type Status = "idle" | "streaming" | "awaiting_approval" | "error"

const chatRef = {
  sessions: {} as Record<string, { status: Status }>,
  activeSessionId: null as string | null,
}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ sessions: chatRef.sessions, activeSessionId: chatRef.activeSessionId }),
}))

import { StatusBarRunState } from "./status-bar-run-state"

/** One focused conversation in `status`, which is what the old test covered. */
function focusedOnly(status: Status) {
  chatRef.sessions = { a: { status } }
  chatRef.activeSessionId = "a"
}

beforeEach(() => {
  chatRef.sessions = {}
  chatRef.activeSessionId = null
})

describe("StatusBarRunState", () => {
  it.each([
    ["idle" as const, "desktop.statusBar.idle"],
    ["streaming" as const, "desktop.statusBar.streaming"],
    ["awaiting_approval" as const, "desktop.statusBar.awaitingApproval"],
    ["error" as const, "desktop.statusBar.error"],
  ])("renders the %s label", (status, label) => {
    focusedOnly(status)
    render(<StatusBarRunState />)
    expect(screen.getByTestId("status-status")).toHaveTextContent(label)
    expect(screen.getByLabelText(label)).toBeInTheDocument()
  })

  it("pulses the dot while streaming", () => {
    focusedOnly("streaming")
    const { container } = render(<StatusBarRunState />)
    expect(container.querySelector(".animate-pulse")).toBeTruthy()
  })

  it("does not pulse when idle", () => {
    focusedOnly("idle")
    const { container } = render(<StatusBarRunState />)
    expect(container.querySelector(".animate-pulse")).toBeNull()
  })

  it("stays out of the tab order — it is a readout, not a control", () => {
    render(<StatusBarRunState />)
    expect(screen.getByTestId("status-status")).toHaveAttribute("tabindex", "-1")
  })

  it("does not say idle because the conversation on screen is", () => {
    // The readout whose entire job is "is anything happening" used to answer
    // for the focused slice alone.
    chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
    chatRef.activeSessionId = "a"
    render(<StatusBarRunState />)
    expect(screen.getByTestId("status-status")).toHaveTextContent("desktop.statusBar.streaming")
  })

  it("shows the count once more than one conversation is running", () => {
    chatRef.sessions = { a: { status: "streaming" }, b: { status: "streaming" } }
    chatRef.activeSessionId = "a"
    render(<StatusBarRunState />)
    expect(screen.getByTestId("status-status")).toHaveTextContent(
      'desktop.statusBar.runningCount:{"count":2}'
    )
  })

  it("keeps the plain label for a single run", () => {
    focusedOnly("streaming")
    render(<StatusBarRunState />)
    expect(screen.getByTestId("status-status")).toHaveTextContent("desktop.statusBar.streaming")
  })

  it("surfaces a blocked approval over a running turn", () => {
    chatRef.sessions = { a: { status: "streaming" }, b: { status: "awaiting_approval" } }
    chatRef.activeSessionId = "a"
    const { container } = render(<StatusBarRunState />)
    // Two are active, so the label is the count; the dot still carries the
    // amber "someone has to decide something" state.
    expect(container.querySelector(".bg-amber-500")).toBeTruthy()
  })

  it("records whether the work is somewhere other than the focused pane", () => {
    chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
    chatRef.activeSessionId = "a"
    render(<StatusBarRunState />)
    const node = screen.getByTestId("status-status")
    expect(node).toHaveAttribute("data-run-elsewhere", "true")
    expect(node).toHaveAttribute("data-run-active", "1")
  })
})
