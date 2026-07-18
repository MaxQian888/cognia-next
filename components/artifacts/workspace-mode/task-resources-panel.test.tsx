import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { TaskResourcesPanel } from "./task-resources-panel"

const listRuns = jest.fn()
const listResources = jest.fn()
const readResource = jest.fn()

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))
jest.mock("@/lib/task-workspace/client", () => ({
  installTaskWorkspaceEventListener: jest.fn(async () => jest.fn()),
  listTaskRuns: (...args: unknown[]) => listRuns(...args),
  listTaskResources: (...args: unknown[]) => listResources(...args),
  readTaskResource: (...args: unknown[]) => readResource(...args),
  readTaskResourceDiff: jest.fn(async () => "@@ diff"),
  getTaskPatchSet: jest.fn(async () => null),
  applyTaskWorkspace: jest.fn(async () => ({ state: "applied", revision: 2, conflicts: [] })),
  undoTaskWorkspace: jest.fn(async () => ({ state: "reverted", revision: 3, conflicts: [] })),
  resolveTaskWorkspaceConflict: jest.fn(async () => ({
    state: "applied",
    revision: 3,
    conflicts: [],
  })),
  downloadTaskResource: jest.fn(async () => new Blob()),
  uploadTaskResource: jest.fn(async () => "hash"),
  pinTaskWorkspace: jest.fn(async (_taskId: string, pinned: boolean) => ({ pinned })),
}))

const resource = {
  runId: "run-1",
  path: "src/result.md",
  oldPath: null,
  kind: "modified",
  origin: "agent",
  agentId: "agent-1",
  mediaType: "text/markdown",
  size: 8,
  hash: "after",
  beforeHash: "before",
  insertions: 1,
  deletions: 1,
  binary: false,
  resourceKind: "file",
  beforeMode: 420,
  afterMode: 420,
  sensitive: false,
  revision: 1,
} as const

describe("TaskResourcesPanel", () => {
  beforeEach(() => {
    useTaskWorkspaceStore.getState().clear()
    useTaskWorkspaceStore.getState().activate({
      taskId: "task-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceRoot: "/repo",
      executionRoot: "/isolated",
      state: "running",
    })
    listRuns.mockResolvedValue([
      { runId: "run-1", agentId: "agent-1", state: "ready", baselineRevision: 0 },
    ])
    listResources.mockResolvedValue([resource])
    readResource.mockResolvedValue({
      content: "# Result",
      encoding: "utf8",
      mediaType: "text/markdown",
      size: 8,
      hash: "after",
      truncated: false,
      nextOffset: null,
      sensitive: false,
    })
  })

  it("reconciles resources and renders source/preview/diff tabs", async () => {
    const user = userEvent.setup()
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByText("src/result.md"))
    expect(await screen.findByText("# Result")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "preview" }))
    expect(await screen.findByText("# Result")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "diff" }))
    expect(await screen.findByText("@@ diff")).toBeInTheDocument()
  })

  it("shows provisional state until authoritative resources load", async () => {
    useTaskWorkspaceStore.getState().ingestEvent({
      taskId: "task-1",
      runId: "run-1",
      revision: 1,
      changes: [{ path: "src/result.md", kind: "modified" }],
      overflow: false,
      resyncRequired: false,
    })
    render(<TaskResourcesPanel sessionId="session-1" layout="mobile" />)
    expect(screen.getByText("provisional")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("authoritative")).toBeInTheDocument())
  })
})
