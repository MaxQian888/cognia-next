/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import { useCharacter } from "@/lib/data-hooks/context"
import {
  SessionOverviewPanel,
  SessionOverviewPanelHost,
  SessionOverviewContext,
} from "./session-overview-panel"
import { useSessionStatus, useSessionPendingApprovals, useSessionErrorMessage } from "@/stores/chat"
import { useSessionPendingElicitation } from "@/stores/agent/external-elicitation-store"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? JSON.stringify(values) : ""}`,
}))
jest.mock("@/stores/chat", () => ({
  useSessionStatus: jest.fn(() => "idle"),
  useSessionPendingApprovals: jest.fn(() => []),
  useSessionErrorMessage: jest.fn(() => null),
}))
jest.mock("@/stores/agent/external-elicitation-store", () => ({
  useSessionPendingElicitation: jest.fn(() => null),
}))
jest.mock("@/stores/agent/ask-user-store", () => ({
  useAskUserStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ active: null, queue: [] })
  ),
}))
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: jest.fn(() => ({ name: "Researcher" })),
}))
jest.mock("@/components/chat/room-participants-chip", () => ({
  RoomParticipantsChip: ({ session }: { session: ChatSession }) => (
    <span>members:{session.id}</span>
  ),
}))
jest.mock("@/components/chat/session-environment-chip", () => ({
  SessionEnvironmentChip: ({ onManage }: { onManage: () => void }) => (
    <button onClick={onManage}>Environment</button>
  ),
}))
jest.mock("@/components/agent/composition/composition-chip", () => ({
  CompositionChip: ({ sessionId, disabled }: { sessionId: string; disabled: boolean }) => (
    <button disabled={disabled}>mode:{sessionId}</button>
  ),
}))
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: ({ sessionId }: { sessionId: string }) => <span>runtime:{sessionId}</span>,
}))
jest.mock("@/components/chat/session-settings-sheet", () => ({
  SessionSettingsSheet: ({ session, open }: { session: ChatSession; open: boolean }) =>
    open ? <div>settings:{session.id}</div> : null,
}))
jest.mock("./session-capabilities-section", () => ({
  SessionCapabilitiesSection: ({
    session,
    onManage,
  }: {
    session: ChatSession
    onManage: () => void
  }) => <button onClick={onManage}>capabilities:{session.id}</button>,
}))
jest.mock("./session-results-section", () => ({
  SessionResultsSection: ({
    session,
    onNavigate,
  }: {
    session: ChatSession
    onNavigate: (id: string) => void
  }) => <button onClick={() => onNavigate("workspace")}>results:{session.id}</button>,
}))

const session = {
  id: "one",
  title: "Review changes",
  model: "model-a",
  providerOverride: "provider-a",
  workingDir: "/repo",
  createdAt: 1,
  workingSet: {
    entries: [{ id: "q", kind: "open-question", status: "active", summary: "Choose release" }],
  },
} as unknown as ChatSession
const mockAskUser = useAskUserStore as unknown as jest.Mock
const props = { session, messages: [], messageCount: 3, onNavigate: jest.fn() }
beforeEach(() => {
  jest.clearAllMocks()
  mockAskUser.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ active: null, queue: [] })
  )
  jest.mocked(useCharacter).mockReturnValue({ name: "Researcher" } as never)
  jest.mocked(useSessionStatus).mockReturnValue("idle")
  jest.mocked(useSessionPendingApprovals).mockReturnValue([])
  jest.mocked(useSessionPendingElicitation).mockReturnValue(null)
  jest.mocked(useSessionErrorMessage).mockReturnValue(null)
})

it("composes existing controls and routes outputs and working context", () => {
  render(<SessionOverviewPanel {...props} />)
  expect(screen.getByRole("heading", { name: session.title })).toBeInTheDocument()
  expect(screen.getByText("Researcher")).toBeInTheDocument()
  expect(screen.getByText("Choose release")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "results:one" }))
  expect(props.onNavigate).toHaveBeenCalledWith("workspace")
  fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.taskOverview.openContext" }))
  expect(props.onNavigate).toHaveBeenCalledWith("run-context")
  fireEvent.click(screen.getByRole("button", { name: "Environment" }))
  expect(screen.getByText("settings:one")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "capabilities:one" }))
})
it("reads status and blockers from the bound session", () => {
  jest.mocked(useSessionStatus).mockReturnValue("streaming")
  jest
    .mocked(useSessionPendingApprovals)
    .mockReturnValue([{ requestId: "a", status: "pending" }] as never)
  render(<SessionOverviewPanel {...props} />)
  expect(useSessionStatus).toHaveBeenCalledWith("one")
  expect(useSessionPendingApprovals).toHaveBeenCalledWith("one")
  expect(screen.getByRole("status")).toHaveTextContent("awaiting_approval")
  expect(screen.getByRole("button", { name: "mode:one" })).toBeDisabled()
})
it("shows external questions and errors, without treating idle as completed", () => {
  jest.mocked(useSessionPendingElicitation).mockReturnValue({ request: { id: "q" } } as never)
  const view = render(<SessionOverviewPanel {...props} />)
  expect(screen.getByRole("status")).toHaveTextContent("awaiting_approval")
  jest.mocked(useSessionPendingElicitation).mockReturnValue(null)
  jest.mocked(useSessionStatus).mockReturnValue("error")
  jest.mocked(useSessionErrorMessage).mockReturnValue("Connection lost")
  view.rerender(<SessionOverviewPanel {...props} />)
  expect(screen.getByRole("alert")).toHaveTextContent("Connection lost")
})
it("keeps technical details and handles missing context", () => {
  render(
    <SessionOverviewPanel
      {...props}
      session={{ id: "two", title: "", createdAt: 1 } as ChatSession}
    />
  )
  expect(screen.getByText("contextWorkbench.taskOverview.noOpenItems")).toBeInTheDocument()
  expect(screen.getByRole("status")).toHaveTextContent("idle")
  expect(
    screen.getByRole("heading", { name: "contextWorkbench.taskOverview.untitled" })
  ).toBeInTheDocument()
  expect(screen.getByText("two")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.taskOverview.manage" }))
  expect(screen.getByText("settings:two")).toBeInTheDocument()
})

it("ignores another session's questions and interrupted approvals", () => {
  mockAskUser.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ active: { sessionId: "other" }, queue: [{ sessionId: "other" }] })
  )
  jest.mocked(useSessionPendingApprovals).mockReturnValue([{ status: "interrupted" }] as never)
  const view = render(<SessionOverviewPanel {...props} />)
  expect(screen.getByRole("status")).toHaveTextContent("idle")
  mockAskUser.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ active: null, queue: [{ sessionId: "one" }] })
  )
  view.rerender(<SessionOverviewPanel {...props} />)
  expect(screen.getByRole("status")).toHaveTextContent("awaiting_approval")
})
it("keeps workflow controls out and only lists active questions and subtasks", () => {
  jest.mocked(useCharacter).mockReturnValue(undefined)
  render(
    <SessionOverviewPanel
      {...props}
      session={
        {
          ...session,
          kind: "workflow-editor",
          executionContext: { branch: "main" },
          workingSet: {
            entries: [
              { id: "1", kind: "subtask", status: "active", summary: "Run checks" },
              { id: "2", kind: "fact", status: "active", summary: "Private fact" },
              { id: "3", kind: "open-question", status: "resolved", summary: "Old question" },
            ],
          },
        } as ChatSession
      }
    />
  )
  expect(screen.queryByRole("button", { name: "mode:one" })).not.toBeInTheDocument()
  expect(screen.getByText("Run checks")).toBeInTheDocument()
  expect(screen.queryByText("Private fact")).not.toBeInTheDocument()
  expect(screen.queryByText("Old question")).not.toBeInTheDocument()
})

it("preserves open controls across live updates and resets them for another session", () => {
  const view = render(
    <SessionOverviewContext.Provider value={props}>
      <SessionOverviewPanelHost />
    </SessionOverviewContext.Provider>
  )
  fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.taskOverview.manage" }))
  view.rerender(
    <SessionOverviewContext.Provider
      value={{ ...props, session: { ...session, title: "Updated title" } }}
    >
      <SessionOverviewPanelHost />
    </SessionOverviewContext.Provider>
  )
  expect(screen.getByText("settings:one")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Updated title" })).toBeInTheDocument()
  view.rerender(
    <SessionOverviewContext.Provider value={{ ...props, session: { ...session, id: "two" } }}>
      <SessionOverviewPanelHost />
    </SessionOverviewContext.Provider>
  )
  expect(screen.queryByText("settings:one")).not.toBeInTheDocument()
  expect(screen.queryByText("settings:two")).not.toBeInTheDocument()
  view.rerender(
    <SessionOverviewContext.Provider value={null}>
      <SessionOverviewPanelHost />
    </SessionOverviewContext.Provider>
  )
  expect(screen.queryByTestId("session-overview-panel")).not.toBeInTheDocument()
})

it("shares one status rail with the compact card rather than a second vocabulary", () => {
  jest.mocked(useSessionPendingApprovals).mockReturnValue([{ status: "pending" }] as never)
  render(<SessionOverviewPanel {...props} />)
  const rail = screen.getByRole("status")
  expect(rail.className).toContain("bg-warning/12")
  expect(rail).toHaveTextContent("contextWorkbench.taskOverview.statusHints.awaiting_approval")
})

it("marks open questions apart from subtasks, as the compact card does", () => {
  render(
    <SessionOverviewPanel
      {...props}
      session={
        {
          ...session,
          workingSet: {
            entries: [
              { id: "q", kind: "open-question", summary: "Choose release", status: "active" },
              { id: "s", kind: "subtask", summary: "Ship it", status: "active" },
            ],
          },
        } as unknown as ChatSession
      }
    />
  )
  const [question, subtask] = screen.getAllByRole("listitem")
  expect(question.querySelector("svg")?.getAttribute("class")).toContain("text-warning")
  expect(subtask.querySelector("svg")?.getAttribute("class")).toContain("text-info")
})
