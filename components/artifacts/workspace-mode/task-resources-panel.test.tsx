import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { TaskResourcesPanel } from "./task-resources-panel"

const listRuns = jest.fn()
const listResources = jest.fn()
const readResource = jest.fn()
const applyWorkspace = jest.fn()
const listEvents = jest.fn()
const getSummary = jest.fn()
const exportManifest = jest.fn()
const getAdoption = jest.fn()

jest.mock("@/lib/code-adoption/persist", () => ({
  getCodeAdoptionTurnByTaskWorkspaceRun: (...args: unknown[]) => getAdoption(...args),
}))

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content, rhythm }: { content: string; rhythm?: string }) => (
    <div data-testid="markdown-renderer" data-rhythm={rhythm}>
      {content}
    </div>
  ),
}))
jest.mock("@/lib/task-workspace/client", () => ({
  installTaskWorkspaceEventListener: jest.fn(async () => jest.fn()),
  listTaskRuns: (...args: unknown[]) => listRuns(...args),
  listTaskResources: (...args: unknown[]) => listResources(...args),
  listTaskResourceEvents: (...args: unknown[]) => listEvents(...args),
  getTaskResourceSummary: (...args: unknown[]) => getSummary(...args),
  exportTaskResourceManifest: (...args: unknown[]) => exportManifest(...args),
  readTaskResource: (...args: unknown[]) => readResource(...args),
  readTaskResourceDiff: jest.fn(async () => "@@ diff"),
  getTaskPatchSet: jest.fn(async () => null),
  applyTaskWorkspace: (...args: unknown[]) => applyWorkspace(...args),
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
    applyWorkspace.mockReset()
    applyWorkspace.mockResolvedValue({ state: "applied", revision: 2, conflicts: [] })
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
    listEvents.mockResolvedValue([
      {
        eventId: "event-1",
        runId: "run-1",
        seq: 1,
        observedAt: Date.now(),
        path: "dist/transient.js",
        oldPath: null,
        kind: "deleted",
        captureClass: "generated",
        origin: "agent",
        evidence: "watcher",
        overflow: false,
        resyncRequired: false,
        reconciled: true,
      },
    ])
    getSummary.mockResolvedValue({
      runId: "run-1",
      counts: { created: 1, modified: 0, deleted: 1, renamed: 0, source: 0, generated: 2 },
      eventCount: 2,
      overflowCount: 1,
      completeness: "reconciled",
    })
    exportManifest.mockResolvedValue({ schemaVersion: 1, events: [] })
    getAdoption.mockResolvedValue({
      id: "session-1:1",
      taskWorkspaceRunId: "run-1",
      measurement: "taskWorkspace",
      trackingState: "tracked",
      adoptionState: "partiallyAccepted",
      proposedAdded: 8,
      proposedRemoved: 2,
      acceptedAdded: 4,
      acceptedRemoved: 1,
      totalAdded: 8,
      totalRemoved: 2,
      truncated: false,
    })
  })

  it("reconciles resources and renders source/preview/diff tabs", async () => {
    const user = userEvent.setup()
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByText("src/result.md"))
    expect(await screen.findByText("# Result")).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "preview" }))
    expect(await screen.findByText("# Result")).toBeInTheDocument()
    expect(screen.getByTestId("markdown-renderer")).toHaveAttribute("data-rhythm", "document")
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

  it("shows the current Task Workspace adoption decision without a separate analytics page", async () => {
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    expect(await screen.findByTestId("code-adoption-summary")).toHaveTextContent("adoptionTitle")
    expect(screen.getByTestId("code-adoption-summary")).toHaveTextContent("adoptionRate")
    expect(getAdoption).toHaveBeenCalledWith("run-1")
  })

  it("requires an explicit confirmation before retrying an irreversible apply", async () => {
    const user = userEvent.setup()
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true)
    applyWorkspace
      .mockRejectedValueOnce(new Error("task workspace ledger capacity exceeded: 11 > 10 bytes"))
      .mockResolvedValueOnce({ state: "applied", revision: 2, conflicts: [] })
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)

    await user.click(screen.getByRole("button", { name: "applyAll" }))

    await waitFor(() => expect(applyWorkspace).toHaveBeenLastCalledWith("run-1", [], true))
    expect(confirm).toHaveBeenCalledWith("irreversibleApplyConfirm")
    confirm.mockRestore()
  })

  it("shows the durable timeline and exports its privacy-safe manifest", async () => {
    const user = userEvent.setup()
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: jest.fn(() => "blob:task-manifest"),
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: jest.fn(),
    })
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {})
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)

    await user.click(await screen.findByRole("tab", { name: "timeline" }))
    expect(await screen.findByText("dist/transient.js")).toBeInTheDocument()
    expect(screen.getByText("reconciled")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "exportManifest" }))

    await waitFor(() => expect(exportManifest).toHaveBeenCalledWith("task-1", "run-1"))
    delete (URL as Partial<typeof URL>).createObjectURL
    delete (URL as Partial<typeof URL>).revokeObjectURL
    anchorClick.mockRestore()
  })
})
