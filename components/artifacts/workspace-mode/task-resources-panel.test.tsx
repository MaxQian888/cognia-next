import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { TaskResourcesPanel } from "./task-resources-panel"
import {
  downloadTaskResource,
  uploadTaskResource,
  readTaskResourceDiff,
  getTaskPatchSet,
  undoTaskWorkspace,
  resolveTaskWorkspaceConflict,
  pinTaskWorkspace,
} from "@/lib/task-workspace/client"

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
    jest.clearAllMocks()
    jest
      .mocked(getTaskPatchSet)
      .mockReset()
      .mockResolvedValue(null as never)
    jest.mocked(readTaskResourceDiff).mockReset().mockResolvedValue("@@ diff")
    jest
      .mocked(undoTaskWorkspace)
      .mockReset()
      .mockResolvedValue({ state: "reverted", revision: 3, conflicts: [] } as never)
    jest
      .mocked(resolveTaskWorkspaceConflict)
      .mockReset()
      .mockResolvedValue({ state: "applied", revision: 3, conflicts: [] } as never)
    jest
      .mocked(pinTaskWorkspace)
      .mockReset()
      .mockImplementation(async (_taskId, pinned) => ({ pinned }) as never)
    jest.mocked(downloadTaskResource).mockReset().mockResolvedValue(new Blob())
    jest.mocked(uploadTaskResource).mockReset().mockResolvedValue("hash")
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: jest.fn(() => "blob:current-resource"),
    })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: jest.fn() })
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
    listEvents.mockResolvedValue({
      items: [
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
      ],
    })
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

  it("aborts the previous preview and ignores its late result after selecting another file", async () => {
    const user = userEvent.setup()
    let resolveFirst!: (blob: Blob) => void
    const first = new Promise<Blob>((resolve) => {
      resolveFirst = resolve
    })
    const secondBlob = new Blob(["second"])
    jest.mocked(downloadTaskResource).mockReturnValueOnce(first).mockResolvedValueOnce(secondBlob)
    listResources.mockResolvedValue([
      { ...resource, path: "first.png", mediaType: "image/png", binary: true },
      { ...resource, path: "second.png", mediaType: "image/png", binary: true },
    ])
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /first.png/ }))
    const signal = jest.mocked(downloadTaskResource).mock.calls[0][3]
    await user.click(screen.getByRole("button", { name: /second.png/ }))
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(secondBlob))
    await act(async () => {
      resolveFirst(new Blob(["stale"]))
    })
    expect(signal?.aborted).toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("tab", { name: "preview" }))
    expect(screen.getByRole("img", { name: "second.png" })).toHaveAttribute(
      "src",
      "blob:current-resource"
    )
    expect(downloadTaskResource).toHaveBeenCalledTimes(2)
  })

  it("cancels preview work on unmount without creating an orphaned object URL", async () => {
    const user = userEvent.setup()
    let resolveDownload!: (blob: Blob) => void
    jest.mocked(downloadTaskResource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve
        })
    )
    listResources.mockResolvedValue([
      { ...resource, path: "image.png", mediaType: "image/png", binary: true },
    ])
    const { unmount } = render(<TaskResourcesPanel sessionId="session-1" layout="mobile" />)
    await user.click(await screen.findByRole("button", { name: /image.png/ }))
    const signal = jest.mocked(downloadTaskResource).mock.calls[0][3]
    unmount()
    await act(async () => {
      resolveDownload(new Blob())
    })
    expect(signal?.aborted).toBe(true)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it("keeps the selected text when an older read rejects after a newer read completes", async () => {
    const user = userEvent.setup()
    let rejectFirst!: (reason: Error) => void
    readResource.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
    )
    listResources.mockResolvedValue([resource, { ...resource, path: "new.md" }])
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.click(screen.getByRole("button", { name: /new.md/ }))
    expect(await screen.findByText("# Result")).toBeInTheDocument()
    await act(async () => {
      rejectFirst(new Error("stale failure"))
    })
    expect(screen.queryByText("stale failure")).not.toBeInTheDocument()
    expect(screen.getByText("# Result")).toBeInTheDocument()
  })

  it("surfaces a download failure and permits retry without an unhandled rejection", async () => {
    const user = userEvent.setup()
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {})
    jest.mocked(downloadTaskResource).mockRejectedValueOnce(new Error("download failed"))
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.click(screen.getByRole("button", { name: "download" }))
    expect(await screen.findByText("download failed")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "download" }))
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:current-resource")
    anchorClick.mockRestore()
  })

  it("aborts an explicit download when the panel unmounts", async () => {
    const user = userEvent.setup()
    let complete!: (blob: Blob) => void
    jest.mocked(downloadTaskResource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {})
    const { unmount } = render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.click(screen.getByRole("button", { name: "download" }))
    const signal = jest.mocked(downloadTaskResource).mock.calls[0][3]
    expect(screen.getByRole("button", { name: "download" })).toBeDisabled()
    unmount()
    await act(async () => {
      complete(new Blob())
    })
    expect(signal?.aborted).toBe(true)
    expect(anchorClick).not.toHaveBeenCalled()
    anchorClick.mockRestore()
  })

  it("aborts an upload on unmount and ignores its late failure", async () => {
    const user = userEvent.setup()
    let rejectUpload!: (reason: Error) => void
    jest.mocked(uploadTaskResource).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject
        })
    )
    const { container, unmount } = render(
      <TaskResourcesPanel sessionId="session-1" layout="desktop" />
    )
    await screen.findByRole("button", { name: /src\/result.md/ })
    // The native file input is intentionally hidden behind the upload button.
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(["upload"], "new.txt")
    )
    const signal = jest.mocked(uploadTaskResource).mock.calls[0][4]
    unmount()
    await act(async () => {
      rejectUpload(new Error("cancelled upload"))
    })
    expect(signal?.aborted).toBe(true)
  })

  it("requires consent for sensitive resources and rechecks it after changing views", async () => {
    const user = userEvent.setup()
    listResources.mockResolvedValue([{ ...resource, sensitive: true }])
    const confirm = jest.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true)
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    expect(readResource).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "authorizeOnce" }))
    expect(readResource).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "authorizeOnce" }))
    expect(await screen.findByText("# Result")).toBeInTheDocument()
    expect(readResource).toHaveBeenLastCalledWith("run-1", resource.path, {
      maxBytes: 1048576,
      allowSensitive: true,
    })
    await user.click(screen.getByRole("tab", { name: "diff" }))
    await user.click(screen.getByRole("button", { name: "authorizeOnce" }))
    expect(await screen.findByText("@@ diff")).toBeInTheDocument()
    expect(readTaskResourceDiff).toHaveBeenLastCalledWith("run-1", resource.path, true)
    confirm.mockRestore()
  })

  it.each(["generated", "not-captured"])("does not download %s resources", async (mode) => {
    const user = userEvent.setup()
    listResources.mockResolvedValue([
      {
        ...resource,
        captureClass: mode === "generated" ? "generated" : "source",
        contentCaptured: mode !== "not-captured",
      },
    ])
    render(<TaskResourcesPanel sessionId="session-1" layout="mobile" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    expect(screen.getByText("generatedMetadataOnly")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "download" })).toBeDisabled()
    expect(readResource).not.toHaveBeenCalled()
  })

  it("does not fetch deleted source content", async () => {
    const user = userEvent.setup()
    listResources.mockResolvedValue([{ ...resource, kind: "deleted" }])
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    expect(await screen.findByText("binarySource")).toBeInTheDocument()
    expect(readResource).not.toHaveBeenCalled()
  })

  it("resolves an apply conflict and refreshes the selected task", async () => {
    const user = userEvent.setup()
    applyWorkspace.mockResolvedValueOnce({
      state: "conflict",
      revision: 2,
      conflicts: [{ reason: "changed on host" }],
    })
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.click(screen.getByRole("button", { name: "applyFile" }))
    expect(await screen.findByText("changed on host")).toBeInTheDocument()
    expect(applyWorkspace).toHaveBeenCalledWith("run-1", [{ path: resource.path, hunkIds: [] }])
    await user.click(screen.getByRole("button", { name: "conflictKeepCurrent" }))
    await waitFor(() =>
      expect(resolveTaskWorkspaceConflict).toHaveBeenCalledWith("run-1", "keepCurrent")
    )
    expect(screen.queryByText("changed on host")).not.toBeInTheDocument()
  })

  it("reports undo failures, preserves conflicts, and allows applying the task version", async () => {
    const user = userEvent.setup()
    jest
      .mocked(undoTaskWorkspace)
      .mockRejectedValueOnce("undo failed")
      .mockResolvedValueOnce({
        state: "conflict",
        conflicts: [{ reason: "undo conflict" }],
      } as never)
    jest.mocked(resolveTaskWorkspaceConflict).mockRejectedValueOnce("resolution failed")
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.click(screen.getByRole("button", { name: "undo" }))
    expect(await screen.findByText("undo failed")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "undo" }))
    expect(await screen.findByText("undo conflict")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "conflictApplyTask" }))
    expect(await screen.findByText("resolution failed")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "conflictApplyTask" }))
    await waitFor(() => expect(screen.queryByText("resolution failed")).not.toBeInTheDocument())
  })

  it("reports a failed apply without silently forcing an irreversible retry", async () => {
    const user = userEvent.setup()
    applyWorkspace.mockRejectedValueOnce("write refused")
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.click(screen.getByRole("button", { name: "applyAll" }))
    expect(await screen.findByText("write refused")).toBeInTheDocument()
    expect(applyWorkspace).toHaveBeenCalledTimes(1)
  })

  it("refreshes after upload and allows pinning and unpinning", async () => {
    const user = userEvent.setup()
    const { container } = render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(["data"], "new.txt")
    )
    await waitFor(() => expect(uploadTaskResource).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listResources).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole("button", { name: "pin" }))
    await user.click(await screen.findByRole("button", { name: "unpin" }))
    expect(await screen.findByRole("button", { name: "pin" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("reports failed upload, pin, and manifest operations", async () => {
    const user = userEvent.setup()
    jest.mocked(uploadTaskResource).mockRejectedValueOnce("upload failed")
    jest.mocked(pinTaskWorkspace).mockRejectedValueOnce("pin failed")
    exportManifest.mockRejectedValueOnce("manifest failed")
    const { container } = render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(["data"], "new.txt")
    )
    expect(await screen.findByText("upload failed")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "pin" }))
    expect(await screen.findByText("pin failed")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "exportManifest" }))
    expect(await screen.findByText("manifest failed")).toBeInTheDocument()
  })

  it.each([
    ["application/json", '{"valid":true}', '"valid": true'],
    ["application/json", "invalid json", "invalid json"],
    ["text/plain", "plain text", "plain text"],
  ])("renders %s without another source download", async (mediaType, content, visible) => {
    const user = userEvent.setup()
    listResources.mockResolvedValue([{ ...resource, mediaType }])
    readResource.mockResolvedValueOnce({ content })
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    await user.click(screen.getByRole("tab", { name: "preview" }))
    expect(await screen.findByText(new RegExp(visible))).toBeInTheDocument()
    expect(readResource).toHaveBeenCalledTimes(1)
  })

  it.each(["text/html", "image/svg+xml"])(
    "keeps %s previews isolated even when script execution is requested",
    async (mediaType) => {
      const user = userEvent.setup()
      listResources.mockResolvedValue([{ ...resource, mediaType }])
      readResource.mockResolvedValueOnce({
        content: "<script>window.parent.alert(1)</script><p>preview</p>",
      })
      render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
      await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
      await user.click(screen.getByRole("tab", { name: "preview" }))
      const frame = await screen.findByTitle("preview")
      expect(frame).toHaveAttribute("sandbox", "")
      expect(frame.getAttribute("srcdoc")).not.toContain("<script>")
      await user.click(screen.getByRole("button", { name: "runSandboxed" }))
      expect(frame).toHaveAttribute("sandbox", "allow-scripts")
      expect(frame.getAttribute("srcdoc")).toContain("connect-src 'none'")
      await user.click(screen.getByRole("button", { name: "staticPreview" }))
      expect(frame).toHaveAttribute("sandbox", "")
    }
  )

  it.each(["audio/wav", "video/mp4", "application/pdf", "application/octet-stream"])(
    "cleans up %s preview URLs",
    async (mediaType) => {
      const user = userEvent.setup()
      listResources.mockResolvedValue([{ ...resource, mediaType, binary: true }])
      const { container, unmount } = render(
        <TaskResourcesPanel sessionId="session-1" layout="desktop" />
      )
      await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
      await user.click(screen.getByRole("tab", { name: "preview" }))
      if (mediaType === "application/octet-stream")
        expect(screen.getByText("previewUnavailable")).toBeInTheDocument()
      else
        expect(container.querySelector("audio,video,iframe")).toHaveAttribute(
          "src",
          "blob:current-resource"
        )
      unmount()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:current-resource")
    }
  )

  it("renders an empty state when no task is active", () => {
    useTaskWorkspaceStore.getState().clear()
    render(<TaskResourcesPanel sessionId="session-1" layout="mobile" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("filters resources and paginated timeline events without losing the next-page cursor", async () => {
    const user = userEvent.setup()
    const recent = {
      eventId: "recent",
      runId: "run-1",
      seq: 1,
      path: "recent.ts",
      origin: "agent",
      kind: "modified",
      captureClass: "source",
      evidence: "watcher",
      observedAt: Date.now(),
    }
    const older = {
      ...recent,
      eventId: "older",
      seq: 2,
      path: "old.ts",
      origin: "user",
      observedAt: Date.now() - 2 * 60 * 60 * 1000,
    }
    listEvents
      .mockResolvedValueOnce({ items: [recent, older], nextPageToken: "next-page" })
      .mockResolvedValue({ items: [{ ...recent, eventId: "page2", seq: 3, path: null }] })
    listResources.mockResolvedValue([{ ...resource, captureClass: "source" }])
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await screen.findByRole("button", { name: /src\/result.md/ })
    await user.selectOptions(screen.getByRole("combobox", { name: "originFilter" }), "user")
    expect(screen.queryByRole("button", { name: /src\/result.md/ })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "originFilter" }), "agent")
    await user.selectOptions(screen.getByRole("combobox", { name: "statusFilter" }), "created")
    expect(screen.queryByRole("button", { name: /src\/result.md/ })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "statusFilter" }), "modified")
    await user.selectOptions(screen.getByRole("combobox", { name: "captureFilter" }), "generated")
    expect(screen.queryByRole("button", { name: /src\/result.md/ })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "captureFilter" }), "source")
    await user.click(screen.getByRole("tab", { name: "timeline" }))
    expect(screen.getByText("recent.ts")).toBeInTheDocument()
    expect(screen.queryByText("old.ts")).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "originFilter" }), "all")
    for (const range of ["5m", "1h", "24h", "all"]) {
      await user.selectOptions(screen.getByRole("combobox", { name: "timeFilter" }), range)
      expect(screen.getByText("recent.ts")).toBeInTheDocument()
      if (range === "5m" || range === "1h")
        expect(screen.queryByText("old.ts")).not.toBeInTheDocument()
      else expect(screen.getByText("old.ts")).toBeInTheDocument()
    }
    await user.click(screen.getByRole("button", { name: "loadMoreEvents" }))
    await waitFor(() =>
      expect(listEvents).toHaveBeenLastCalledWith("run-1", {
        pageSize: 1000,
        pageToken: "next-page",
      })
    )
    expect(screen.queryByRole("button", { name: "loadMoreEvents" })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "statusFilter" }), "deleted")
    expect(screen.getByText("timelineEmpty")).toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "captureFilter" }), "generated")
    expect(screen.getByText("timelineEmpty")).toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "runFilter" }), "run-1")
  })

  it("applies only checked hunks and disables undo for irreversible patches", async () => {
    const user = userEvent.setup()
    jest.mocked(getTaskPatchSet).mockResolvedValue({
      reversible: false,
      files: [
        {
          path: resource.path,
          hunks: [
            { id: "h1", header: "@@ first" },
            { id: "h2", header: "@@ second" },
          ],
        },
      ],
    } as never)
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    await user.click(await screen.findByRole("button", { name: /src\/result.md/ }))
    expect(screen.getByRole("button", { name: "undo" })).toBeDisabled()
    await user.click(screen.getByRole("tab", { name: "diff" }))
    await user.click(screen.getByRole("checkbox", { name: "@@ first" }))
    await user.click(screen.getByRole("checkbox", { name: "@@ second" }))
    await user.click(screen.getByRole("checkbox", { name: "@@ second" }))
    await user.click(screen.getByRole("button", { name: "applySelectedHunks" }))
    await waitFor(() =>
      expect(applyWorkspace).toHaveBeenLastCalledWith("run-1", [
        { path: resource.path, hunkIds: ["h1"] },
      ])
    )
  })

  it.each([
    [{ measurement: "generation" }, "adoptionGenerationOnly"],
    [{ measurement: "taskWorkspace", trackingState: "unavailable" }, "adoptionUnavailable"],
    [{ measurement: "taskWorkspace", adoptionState: "unavailable" }, "adoptionUnavailable"],
    [{ measurement: "taskWorkspace", adoptionState: "pending" }, "adoptionPending"],
    [{ measurement: "taskWorkspace", adoptionState: "reverted" }, "adoptionReverted"],
    [{ measurement: "taskWorkspace", adoptionState: "rejected" }, "adoptionRejected"],
    [{ measurement: "taskWorkspace", adoptionState: "accepted" }, "adoptionRate"],
  ])("reports adoption state %j independently of preview loading", async (row, detail) => {
    getAdoption.mockResolvedValue({ totalAdded: 0, totalRemoved: 0, ...row })
    render(<TaskResourcesPanel sessionId="session-1" layout="desktop" />)
    expect(await screen.findByText(detail)).toBeInTheDocument()
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
