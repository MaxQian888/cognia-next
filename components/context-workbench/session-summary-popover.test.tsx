/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useState, type ReactNode } from "react"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { SessionSummaryDockContext, SessionSummaryPopover } from "./session-summary-popover"
import { useSessionOverviewState } from "./session-overview-panel"
import { useSessionMessages } from "@/stores/chat"
import { useCharacter } from "@/lib/data-hooks/context"

const mockFocus = jest.fn()
const mockArtifact = jest.fn()
let mockActiveSessionId = "one"
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => ({ setActiveArtifact: mockArtifact }) },
}))
const mockReveal = jest.fn()
const mockCollapse = jest.fn()
jest.mock("@/hooks/ui", () => ({ useBreakpoint: jest.fn(() => "desktop") }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("./session-overview-panel", () => ({
  useSessionOverviewState: jest.fn(() => ({
    status: "idle",
    displayStatus: "idle",
    busy: false,
    error: null,
  })),
}))
jest.mock("@/stores/chat", () => ({
  useSessionMessages: jest.fn(() => []),
  useChatStore: {
    getState: () => ({ activeSessionId: mockActiveSessionId, setActiveSession: mockFocus }),
  },
}))
jest.mock("@/components/agent/composition/composition-chip", () => ({
  CompositionChip: ({ sessionId, disabled }: { sessionId: string; disabled: boolean }) => (
    <button disabled={disabled}>mode:{sessionId}</button>
  ),
}))
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: () => <span>runtime</span>,
}))
jest.mock("@/components/chat/shared-session-panel", () => ({
  SharedSessionPanel: () => <button>Share</button>,
}))
jest.mock("@/components/chat/room-participants-chip", () => ({ RoomParticipantsChip: () => null }))
jest.mock("@/lib/data-hooks/context", () => ({ useCharacter: jest.fn(() => null) }))
jest.mock("@/components/chat/session-environment-chip", () => ({
  SessionEnvironmentChip: ({ onManage }: { onManage: () => void }) => (
    <button onClick={onManage}>environment</button>
  ),
}))
jest.mock("./session-capabilities-section", () => ({
  SessionCapabilitiesSection: ({
    compact,
    onManage,
  }: {
    compact: boolean
    onManage: () => void
  }) => <button onClick={onManage}>capabilities:{String(compact)}</button>,
}))
jest.mock("./session-results-section", () => ({
  SessionResultsSection: ({
    compact,
    onNavigate,
  }: {
    compact: boolean
    onNavigate: (id: string) => void
  }) => <button onClick={() => onNavigate("workspace")}>results:{String(compact)}</button>,
}))
const session = { id: "one", title: "First", workingDir: "/repo" } as ChatSession
const manage = jest.fn()
const reveal = useArtifactDockLayoutStore.getState().requestReveal
const collapse = useArtifactDockLayoutStore.getState().setDockCollapsed
function Host({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  return (
    <SessionSummaryDockContext.Provider value={host}>
      <aside ref={setHost} data-testid="reserved-host" />
      {children}
    </SessionSummaryDockContext.Provider>
  )
}
function view(current = session) {
  return <SessionSummaryPopover key={current.id} session={current} onManage={manage} />
}
beforeEach(() => {
  jest.clearAllMocks()
  mockActiveSessionId = "one"
  jest.mocked(useBreakpoint).mockReturnValue("desktop")
  useArtifactDockLayoutStore.setState({
    summarySessionId: null,
    dockCollapsed: false,
    dockSize: 42,
    requestReveal: (intent) => {
      mockReveal(intent)
      reveal(intent)
    },
    setDockCollapsed: (value) => {
      mockCollapse(value)
      collapse(value)
    },
  })
  jest
    .mocked(useSessionOverviewState)
    .mockReturnValue({ status: "idle", displayStatus: "idle", busy: false, error: null })
})
it("mounts into the reserved region on demand without changing the full dock width", () => {
  render(<Host>{view()}</Host>)
  expect(useSessionMessages).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  expect(screen.getByTestId("reserved-host")).toContainElement(
    screen.getByTestId("session-summary")
  )
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(screen.getByTestId("session-summary-card")).toHaveClass(
    "rounded-2xl",
    "shadow-lg",
    "max-h-full"
  )
  expect(screen.getByTestId("session-summary-card")).not.toHaveClass("h-full")
  expect(screen.getByRole("button", { name: "summaryTitle" })).toHaveAttribute(
    "aria-expanded",
    "true"
  )
  expect(useArtifactDockLayoutStore.getState()).toMatchObject({
    summarySessionId: "one",
    dockCollapsed: true,
    dockSize: 42,
  })
  expect(useSessionMessages).toHaveBeenCalledWith("one")
  fireEvent.keyDown(document.body, { key: "Escape" })
  expect(screen.queryByTestId("session-summary")).not.toBeInTheDocument()
  expect(useArtifactDockLayoutStore.getState().dockSize).toBe(42)
})
it("routes details and results to the bound session's full workbench", () => {
  render(<Host>{view()}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  fireEvent.click(screen.getByRole("button", { name: "viewDetails" }))
  expect(mockReveal).toHaveBeenCalledWith({ panelId: "metadata", mode: "wide" })
  expect(mockArtifact).toHaveBeenCalledWith(null, "one")
  expect(useArtifactDockLayoutStore.getState()).toMatchObject({
    summarySessionId: null,
    dockCollapsed: false,
  })
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  fireEvent.click(screen.getByRole("button", { name: "results:true" }))
  expect(mockReveal).toHaveBeenLastCalledWith({ panelId: "workspace", mode: "wide" })
})
it("delegates management and displays scoped errors", () => {
  jest.mocked(useSessionOverviewState).mockReturnValue({
    status: "error",
    displayStatus: "error",
    busy: false,
    error: "Disconnected",
  })
  render(<Host>{view()}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  expect(screen.getByRole("alert")).toHaveTextContent("Disconnected")
  fireEvent.click(screen.getByRole("button", { name: "capabilities:true" }))
  expect(manage).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId("session-summary")).not.toBeInTheDocument()
})
it("keeps updates open but never renders another session's content", () => {
  const rendered = render(<Host>{view()}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  rendered.rerender(<Host>{view({ ...session, title: "Updated" })}</Host>)
  expect(screen.getByTestId("session-summary")).toBeVisible()
  act(() => useArtifactDockLayoutStore.getState().clearSessionScopedReveals())
  rendered.rerender(
    <Host>
      {view({
        id: "two",
        title: "Second",
        kind: "workflow-editor",
        executionContext: {},
      } as ChatSession)}
    </Host>
  )
  expect(screen.queryByTestId("session-summary")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  expect(useSessionMessages).toHaveBeenLastCalledWith("two")
  expect(screen.queryByText("mode:two")).not.toBeInTheDocument()
  expect(screen.queryByText("/repo")).not.toBeInTheDocument()
})
it("focuses a background task before opening its summary or revealing its details", () => {
  mockActiveSessionId = "other"
  render(<Host>{view()}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  expect(mockFocus).toHaveBeenCalledWith("one")
  fireEvent.click(screen.getByRole("button", { name: "viewDetails" }))
  expect(mockFocus.mock.invocationCallOrder[0]).toBeLessThan(mockReveal.mock.invocationCallOrder[0])
})
it("uses a responsive Sheet on narrow screens and closes through its existing Escape handling", () => {
  jest.mocked(useBreakpoint).mockReturnValue("mobile")
  render(view())
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  expect(screen.getByRole("dialog", { name: "summaryTitle" })).toBeVisible()
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})
it("has no close button and closes from the trigger, while a nested menu owns its own Escape", () => {
  render(<Host>{view()}</Host>)
  const trigger = screen.getByRole("button", { name: "summaryTitle" })
  fireEvent.click(trigger)
  const menu = document.createElement("div")
  menu.setAttribute("role", "menu")
  document.body.append(menu)
  fireEvent.keyDown(menu, { key: "Escape" })
  expect(screen.getByTestId("session-summary")).toBeVisible()
  menu.remove()
  expect(screen.queryByRole("button", { name: "closeSummary" })).not.toBeInTheDocument()
  fireEvent.click(trigger)
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.click(trigger)
  expect(screen.queryByTestId("session-summary")).not.toBeInTheDocument()
})

it("groups reused controls into labeled definition rows", () => {
  render(<Host>{view()}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  // `status` is deliberately absent: it moved out of the definition list and
  // into the tinted rail, which is the only thing on the card that separates
  // "working" from "waiting for you" from "idle" at a glance.
  expect(screen.queryByText("rows.status")).not.toBeInTheDocument()
  for (const label of ["sharing", "mode", "runtime", "environment", "directory"]) {
    const term = screen.getByText(`rows.${label}`)
    expect(term.tagName).toBe("DT")
    expect(term.parentElement).toHaveClass("min-h-6")
    expect(term.nextElementSibling?.tagName).toBe("DD")
    expect(term.parentElement?.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  }
})

it("names its own subject, because the card is portalled away from the header", () => {
  jest.mocked(useCharacter).mockReturnValue({ id: "c1", name: "Rex" } as never)
  render(<Host>{view()}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  const card = screen.getByTestId("session-summary")
  expect(card.querySelector("h2")).toHaveTextContent("First")
  expect(screen.getByText("Rex")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "manage" }))
  expect(manage).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId("session-summary")).not.toBeInTheDocument()
})

it("falls back to the untitled label rather than an empty heading", () => {
  render(<Host>{view({ ...session, title: "" })}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  expect(screen.getByTestId("session-summary").querySelector("h2")).toHaveTextContent("untitled")
})

it("separates waiting from working in the status rail instead of one grey badge", () => {
  jest.mocked(useSessionOverviewState).mockReturnValue({
    status: "idle",
    displayStatus: "awaiting_approval",
    busy: true,
    error: null,
  })
  render(<Host>{view()}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  const rail = screen.getByRole("status")
  expect(rail).toHaveTextContent("statuses.awaiting_approval")
  expect(rail).toHaveTextContent("statusHints.awaiting_approval")
  expect(rail.className).toContain("bg-warning/12")
})

it("surfaces the session's open questions and subtasks, capped, with a route to the rest", () => {
  const entries = [
    { id: "a", kind: "open-question", summary: "Which width?", status: "active" },
    { id: "b", kind: "subtask", summary: "Pin the test", status: "active" },
    { id: "c", kind: "subtask", summary: "Third", status: "active" },
    { id: "d", kind: "subtask", summary: "Fourth", status: "active" },
    // Resolved entries and other kinds are not outstanding work.
    { id: "e", kind: "subtask", summary: "Done", status: "resolved" },
    { id: "f", kind: "decision", summary: "Chose Dexie", status: "active" },
  ]
  render(<Host>{view({ ...session, workingSet: { entries } } as unknown as ChatSession)}</Host>)
  fireEvent.click(screen.getByRole("button", { name: "summaryTitle" }))
  expect(screen.getByText("Which width?")).toBeVisible()
  expect(screen.getByText("Third")).toBeVisible()
  expect(screen.queryByText("Fourth")).not.toBeInTheDocument()
  expect(screen.queryByText("Done")).not.toBeInTheDocument()
  expect(screen.queryByText("Chose Dexie")).not.toBeInTheDocument()
  expect(screen.getByText("openItemsMore")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "openContext" }))
  expect(mockReveal).toHaveBeenCalledWith({ panelId: "run-context", mode: "wide" })
})
