/** @jest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

import { SessionSummaryCard } from "./session-summary-card"
import { useSessionSummaryCardPrefs } from "@/components/shell/use-session-summary-card-prefs"
import { useSessionNeedsYou } from "@/hooks/chat/use-session-needs-you"
import {
  summarizeResourceChanges,
  useSessionResourceChanges,
} from "@/hooks/chat/use-session-resource-changes"
import { summarizeRunProgress, useSessionRunProgress } from "@/hooks/chat/use-session-run-progress"
import { revealArtifactInWorkspace, revealSessionPanel } from "@/lib/artifacts/reveal"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import type { ResourceChange } from "@/lib/task-workspace/types"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSessionMessages, useSessionStatus } from "@/stores/chat"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"
import { DEFAULT_SUMMARY_CARD_ROWS } from "@/types/shell/session-summary-card"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns.split(".").at(-1)}.${key}${values ? JSON.stringify(values) : ""}`,
}))
jest.mock("@/components/shell/use-session-summary-card-prefs", () => ({
  useSessionSummaryCardPrefs: jest.fn(),
}))
jest.mock("@/hooks/chat/use-session-needs-you", () => ({ useSessionNeedsYou: jest.fn() }))
jest.mock("@/hooks/chat/use-session-resource-changes", () => ({
  ...jest.requireActual("@/hooks/chat/use-session-resource-changes"),
  useSessionResourceChanges: jest.fn(),
}))
jest.mock("@/hooks/chat/use-session-run-progress", () => ({
  ...jest.requireActual("@/hooks/chat/use-session-run-progress"),
  useSessionRunProgress: jest.fn(),
}))
jest.mock("@/lib/artifacts/reveal", () => ({
  revealArtifactInWorkspace: jest.fn(),
  revealSessionPanel: jest.fn(),
}))
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: jest.fn(() => Promise.resolve(true)),
}))
jest.mock("@/stores/chat", () => ({
  useSessionMessages: jest.fn(() => []),
  useSessionStatus: jest.fn(() => "idle"),
}))
let sharedChatEnabled = false
jest.mock("@/hooks/collab/use-shared-chat-enabled", () => ({
  useSharedChatEnabled: () => sharedChatEnabled,
}))
jest.mock("@/components/chat/room-participants-chip", () => ({
  RoomParticipantsChip: () => <span data-testid="participants" />,
}))
jest.mock("@/components/chat/shared-session-panel", () => ({
  SharedSessionPanel: ({ session }: { session: { collaboration?: unknown } }) => (
    <button type="button">
      {session.collaboration ? "open shared controls" : "open private controls"}
    </button>
  ),
}))
jest.mock("./session-summary-card-menu", () => ({
  SessionSummaryCardMenu: () => <button type="button">menu</button>,
}))

const session = {
  id: "s1",
  title: "Rotate tokens",
  projectId: "p1",
  createdAt: 1,
} as unknown as ChatSession

function changes(rows: Array<[string, number | null, number | null]>, available = true) {
  const resources = rows.map(
    ([path, insertions, deletions]) => ({ path, insertions, deletions }) as ResourceChange
  )
  return {
    available,
    resources,
    tracked: true,
    loading: false,
    settled: true,
    failed: false,
    totals: summarizeResourceChanges(resources),
    retry: jest.fn(),
  }
}

const onNavigated = jest.fn()
const onManageSources = jest.fn()
const onManage = jest.fn()

function renderCard() {
  return render(
    <SessionSummaryCard
      session={session}
      width={288}
      mode="popover"
      onNavigated={onNavigated}
      onManage={onManage}
      onManageSources={onManageSources}
    />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  sharedChatEnabled = false
  jest.mocked(useSessionSummaryCardPrefs).mockReturnValue({
    rows: { ...DEFAULT_SUMMARY_CARD_ROWS },
    isDefault: true,
    setRow: jest.fn(),
    reset: jest.fn(),
  })
  jest.mocked(useSessionRunProgress).mockReturnValue(summarizeRunProgress([]))
  jest.mocked(useSessionNeedsYou).mockReturnValue({ items: [], jumpMessageId: null })
  jest.mocked(useSessionResourceChanges).mockReturnValue(changes([]))
  jest.mocked(useSessionMessages).mockReturnValue([])
  jest.mocked(useSessionStatus).mockReturnValue("idle")
  useArtifactStore.setState({ artifacts: {} })
  useProjectStore.setState({
    projects: [{ id: "p1", name: "cognia-next", roots: [{ path: "/repo", isPrimary: true }] }],
  } as never)
  useGitStore.setState({ rootDir: null, status: null })
})

it("shows only the standing rows for a quiet conversation", () => {
  renderCard()
  expect(screen.getByTestId("summary-row-changes")).toHaveTextContent("summaryCard.changesNone")
  expect(screen.getByTestId("summary-sources")).toHaveTextContent("summaryCard.sourcesNone")
  expect(screen.queryByTestId("summary-row-progress")).not.toBeInTheDocument()
  expect(screen.queryByTestId("summary-row-needs-you")).not.toBeInTheDocument()
  expect(screen.queryByTestId("summary-row-artifacts")).not.toBeInTheDocument()
  // Shared chat is off, so its only control would be a disabled button.
  expect(screen.queryByTestId("summary-row-sharing")).not.toBeInTheDocument()
})

it("offers sharing once shared chat is on, and keeps it for a shared room", () => {
  sharedChatEnabled = true
  const view = renderCard()
  const row = screen.getByRole("group", { name: "summaryCard.rows.sharing" })
  expect(row).toHaveTextContent("chatCollaboration.private")
  expect(within(row).getByRole("button", { name: "open private controls" })).toBeInTheDocument()
  view.unmount()

  sharedChatEnabled = false
  render(
    <SessionSummaryCard
      session={{ ...session, collaboration: { orgId: "o", sessionId: "r" } } as never}
      width={288}
      mode="popover"
      onNavigated={onNavigated}
      onManage={onManage}
      onManageSources={onManageSources}
    />
  )
  const shared = screen.getByTestId("summary-row-sharing")
  expect(shared).toHaveTextContent("chatCollaboration.shared")
  expect(within(shared).getByTestId("participants")).toBeInTheDocument()
  expect(within(shared).getByRole("button", { name: "open shared controls" })).toBeInTheDocument()
})

it("names the workspace and the branch a git panel on its root reports", () => {
  useGitStore.setState({ rootDir: "/repo", status: { branch: "feat/rotate" } } as never)
  renderCard()
  expect(screen.getByText("cognia-next")).toBeInTheDocument()
  expect(screen.getByText("feat/rotate")).toBeInTheDocument()
})

it("does not borrow the branch of a different repository", () => {
  useGitStore.setState({ rootDir: "/elsewhere", status: { branch: "main" } } as never)
  renderCard()
  expect(screen.queryByText("main")).not.toBeInTheDocument()
})

it("prefers the managed worktree's branch, and says when there is no workspace", () => {
  useProjectStore.setState({ projects: [] } as never)
  render(
    <SessionSummaryCard
      session={{ ...session, executionContext: { branch: "cognia/wt-1" } } as never}
      width={288}
      mode="popover"
      onNavigated={onNavigated}
      onManage={onManage}
      onManageSources={onManageSources}
    />
  )
  expect(screen.getByText("summaryCard.noWorkspace")).toBeInTheDocument()
  expect(screen.getByText("cognia/wt-1")).toBeInTheDocument()
})

it("shows the step in progress and opens the run context", () => {
  jest.mocked(useSessionStatus).mockReturnValue("streaming")
  jest.mocked(useSessionRunProgress).mockReturnValue(
    summarizeRunProgress([
      { content: "Design", status: "completed" },
      { content: "Remove legacy", activeForm: "Removing legacy", status: "in_progress" },
      { content: "Test", status: "pending" },
    ])
  )
  renderCard()
  const row = screen.getByTestId("summary-row-progress")
  expect(row).toHaveTextContent('progressCurrent{"done":1,"total":3,"step":"Removing legacy"}')
  expect(row).toHaveTextContent("1/3")
  fireEvent.click(row)
  expect(revealSessionPanel).toHaveBeenCalledWith("s1", "run-context")
  expect(onNavigated).toHaveBeenCalled()
})

it("jumps to the waiting turn when something needs the user", () => {
  jest.mocked(useSessionNeedsYou).mockReturnValue({
    items: [{ kind: "approval", id: "a1", label: "Run tests" }],
    jumpMessageId: "m9",
  })
  renderCard()
  const row = screen.getByTestId("summary-row-needs-you")
  expect(row).toHaveTextContent('needsYou{"count":1}')
  expect(row).toHaveTextContent("Run tests")
  fireEvent.click(row)
  expect(jumpToSessionMessage).toHaveBeenCalledWith("s1", "m9")
})

it("totals line changes and opens the workspace", () => {
  jest.mocked(useSessionResourceChanges).mockReturnValue(
    changes([
      ["a.ts", 300, 100],
      ["b.ts", 92, 68],
    ])
  )
  renderCard()
  const row = screen.getByTestId("summary-row-changes")
  expect(row).toHaveTextContent("+392")
  expect(row).toHaveTextContent("−168")
  expect(row).toHaveTextContent('linesAdded{"count":392}, summaryCard.linesRemoved{"count":168}')
  fireEvent.click(row)
  expect(revealSessionPanel).toHaveBeenCalledWith("s1", "workspace")
})

it("falls back to a file count when some line counts are missing", () => {
  jest.mocked(useSessionResourceChanges).mockReturnValue(
    changes([
      ["a.ts", 3, 1],
      ["logo.png", null, null],
    ])
  )
  renderCard()
  const row = screen.getByTestId("summary-row-changes")
  expect(row).toHaveTextContent('changesFiles{"count":2}')
  expect(row).not.toHaveTextContent("+3")
})

it("says change tracking is unavailable on hosts without it", () => {
  jest.mocked(useSessionResourceChanges).mockReturnValue(changes([], false))
  renderCard()
  expect(screen.getByTestId("summary-row-changes")).toHaveTextContent(
    "summaryCard.changesUnavailable"
  )
})

it("opens a lone artifact directly and several through the artifact list", () => {
  useArtifactStore.setState({
    artifacts: {
      a1: { id: "a1", sessionId: "s1", type: "document", updatedAt: new Date(1) },
      other: { id: "other", sessionId: "s2", type: "document", updatedAt: new Date(1) },
    } as never,
  })
  const view = renderCard()
  fireEvent.click(screen.getByTestId("summary-row-artifacts"))
  expect(revealArtifactInWorkspace).toHaveBeenCalledWith("a1")

  act(() =>
    useArtifactStore.setState({
      artifacts: {
        a1: { id: "a1", sessionId: "s1", type: "document", updatedAt: new Date(1) },
        a2: { id: "a2", sessionId: "s1", type: "code", updatedAt: new Date(2) },
      } as never,
    })
  )
  view.rerender(
    <SessionSummaryCard
      session={session}
      width={288}
      mode="popover"
      onNavigated={onNavigated}
      onManage={onManage}
      onManageSources={onManageSources}
    />
  )
  const row = screen.getByTestId("summary-row-artifacts")
  expect(row).toHaveTextContent('artifactCount{"count":2}')
  fireEvent.click(row)
  expect(revealSessionPanel).toHaveBeenCalledWith("s1", "artifacts")
})

it("groups sources, caps the list and routes to the sources panel", () => {
  jest.mocked(useSessionMessages).mockReturnValue([
    {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "source-url", url: "https://a.dev" },
        { type: "source-url", url: "https://b.dev" },
        { type: "tool-read", toolCallId: "t1" },
        { type: "source-document", sourceId: "d1" },
        { type: "file", url: "https://cdn.dev/x.csv" },
      ],
    },
  ] as never)
  renderCard()
  const sources = screen.getByTestId("summary-sources")
  // Web (2) first, then three groups of one capped to the limit of three rows.
  const rows = within(sources).getAllByRole("button")
  expect(rows[1]).toHaveTextContent("sessionSources.labels.web")
  expect(rows[1]).toHaveTextContent('sourceCount{"count":2}')
  expect(within(sources).queryByText("sessionSources.labels.file")).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId("summary-sources-view-all"))
  expect(revealSessionPanel).toHaveBeenCalledWith("s1", "session-sources")
  fireEvent.click(within(sources).getByRole("button", { name: "summaryCard.addSource" }))
  expect(onManageSources).toHaveBeenCalled()
})

it("honours per-row visibility", () => {
  jest.mocked(useSessionSummaryCardPrefs).mockReturnValue({
    rows: { ...DEFAULT_SUMMARY_CARD_ROWS, changes: "never", sources: "never", artifacts: "always" },
    isDefault: false,
    setRow: jest.fn(),
    reset: jest.fn(),
  })
  renderCard()
  expect(screen.queryByTestId("summary-row-changes")).not.toBeInTheDocument()
  expect(screen.queryByTestId("summary-sources")).not.toBeInTheDocument()
  expect(screen.getByTestId("summary-row-artifacts")).toBeInTheDocument()
})

it("hides the sharing row when the user turned it off", () => {
  sharedChatEnabled = true
  jest.mocked(useSessionSummaryCardPrefs).mockReturnValue({
    rows: { ...DEFAULT_SUMMARY_CARD_ROWS, sharing: "never" },
    isDefault: false,
    setRow: jest.fn(),
    reset: jest.fn(),
  })
  renderCard()
  expect(screen.queryByTestId("summary-row-sharing")).not.toBeInTheDocument()
})

it("names its subject and keeps the given size", () => {
  renderCard()
  const card = screen.getByRole("region", { name: 'summaryCard.card{"title":"Rotate tokens"}' })
  expect(card).toHaveStyle({ width: "288px" })
  expect(card).toHaveAttribute("data-mode", "popover")
})

it("opens the task settings from its header", () => {
  renderCard()
  fireEvent.click(screen.getByRole("button", { name: "taskOverview.manage" }))
  expect(onManage).toHaveBeenCalled()
})
