jest.mock("@/lib/git/commands", () => ({ gitDiffFile: jest.fn(), gitReadBlobAtRef: jest.fn() }))
let mockFsBackend = true
jest.mock("@/lib/files/workspace-backend", () => ({ hasWorkspaceFsBackend: () => mockFsBackend }))
jest.mock("@/lib/files/workspace-fs", () => ({
  readWorkspaceFile: jest.fn(),
  writeWorkspaceFile: jest.fn(),
}))
jest.mock("@/lib/files/project-editor-bridge", () => ({ notifyProjectFileSaved: jest.fn() }))
let mockSettings: unknown = { gitSettings: {} }
let mockSaveResult: string | null = null
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings }),
}))
jest.mock("@/hooks/git/use-ai-diff-review", () => ({
  useAiDiffReview: () => ({ reviewing: false, error: null, review: jest.fn() }),
}))
jest.mock("@/hooks/ui/use-resizable-layout", () => ({
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
}))
// Stub the resizable wrapper — the real Group measures the DOM, which jsdom
// can't satisfy. Pass children straight through.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-group">{children}</div>
  ),
  ResizablePanel: ({ children, id }: { children: React.ReactNode; id?: string }) => (
    <div data-testid={id ? `resizable-panel-${id}` : "resizable-panel"}>{children}</div>
  ),
  ResizableHandle: () => <div data-slot="resizable-handle" />,
}))
// Stub the Monaco-backed viewer; expose hunk actions as buttons so we can
// exercise DiffPane's action routing without mounting Monaco.
jest.mock("./diff-viewer", () => ({
  DiffViewer: ({
    diff,
    hunkActions,
    toolbarStart,
    toolbarEnd,
    onOpenLine,
    edit,
    onLoadOmitted,
    onCurrentChange,
  }: {
    diff: { newContent?: string; oldContent?: string; contentOmitted?: boolean } | null
    hunkActions?: { icon: string; onClick: (h: unknown) => void }[]
    toolbarStart?: React.ReactNode
    toolbarEnd?: React.ReactNode
    onOpenLine?: (line: number) => void
    edit?: { draftKey: string; save: (c: string, e: string | null) => Promise<string> }
    onLoadOmitted?: () => Promise<void>
    onCurrentChange?: (i: number) => void
  }) => (
    <div
      data-testid="diff-viewer-stub"
      data-has-diff={diff ? "yes" : "no"}
      data-edit-key={edit?.draftKey ?? ""}
      data-old={diff?.oldContent ?? ""}
      data-new={diff?.newContent ?? ""}
      data-omitted={String(Boolean(diff?.contentOmitted))}
    >
      {edit ? (
        <>
          <button
            data-testid="stub-save"
            onClick={() => void edit.save("mine\n", "disk\n").then((r) => (mockSaveResult = r))}
          />
          <button
            data-testid="stub-save-force"
            onClick={() => void edit.save("mine\n", null).then((r) => (mockSaveResult = r))}
          />
        </>
      ) : null}
      {onLoadOmitted ? (
        <button data-testid="stub-load-omitted" onClick={() => void onLoadOmitted()} />
      ) : null}
      {onCurrentChange ? (
        <button data-testid="stub-current-0" onClick={() => onCurrentChange(0)} />
      ) : null}
      <div data-testid="stub-toolbar-start">{toolbarStart}</div>
      <div data-testid="stub-toolbar-end">{toolbarEnd}</div>
      {onOpenLine ? (
        <button data-testid="stub-open-line" onClick={() => onOpenLine(7)}>
          open
        </button>
      ) : null}
      {(hunkActions ?? []).map((a) => (
        <button key={a.icon} data-testid={`stub-hunk-${a.icon}`} onClick={() => a.onClick(hunk)}>
          {a.icon}
        </button>
      ))}
    </div>
  ),
  DiffToolbar: ({ start }: { start?: React.ReactNode }) => (
    <div data-testid="pending-toolbar">{start}</div>
  ),
  DiffLoading: () => <div data-testid="diff-loading-stub" />,
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { gitDiffFile } from "@/lib/git/commands"
import { DiffPane } from "./diff-pane"
import { useGitStore } from "@/stores/git/git-store"
import type { GitHunk } from "@/types/git"

const gitDiffFileMock = gitDiffFile as jest.Mock

const hunk: GitHunk = {
  header: "@@",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  patch: "PATCH",
  lines: [],
}

function makeActions() {
  return {
    stage: jest.fn().mockResolvedValue(undefined),
    unstage: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  gitDiffFileMock.mockReset().mockResolvedValue({
    path: "a.ts",
    oldContent: "",
    newContent: "",
    hunks: [hunk],
    isBinary: false,
  })
  mockSettings = { gitSettings: {} }
  act(() => {
    useGitStore.getState().reset()
    // Every real mount reviews the store's own repository (the dock gates on
    // `gitRootDir === rootPath`), and the pane only caches into that one.
    useGitStore.getState().setRootDir("/r")
  })
})

describe("DiffPane", () => {
  it("loads the working diff and shows stage + discard hunk actions", async () => {
    const actions = makeActions()
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={actions} />)
    await waitFor(() => expect(gitDiffFileMock).toHaveBeenCalledWith("/r", "a.ts", false))
    expect(screen.getByTestId("stub-hunk-stage")).toBeInTheDocument()
    expect(screen.getByTestId("stub-hunk-discard")).toBeInTheDocument()
  })

  it("stage-hunk sends the hunk patch", async () => {
    const actions = makeActions()
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={actions} />)
    await screen.findByTestId("stub-hunk-stage")
    await act(async () => {
      fireEvent.click(screen.getByTestId("stub-hunk-stage"))
    })
    expect(actions.stage).toHaveBeenCalledWith([], "PATCH")
  })

  it("keeps the diff cached when a hunk mutation fails", async () => {
    const actions = makeActions()
    actions.stage.mockResolvedValue({ kind: "commandFailed", detail: "patch no longer applies" })
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={actions} />)
    await screen.findByTestId("stub-hunk-stage")

    await act(async () => {
      fireEvent.click(screen.getByTestId("stub-hunk-stage"))
    })

    expect(useGitStore.getState().getCachedDiff("w:a.ts")).toBeDefined()
  })

  it("shows an unstage action for staged diffs", async () => {
    const actions = makeActions()
    render(<DiffPane rootDir="/r" path="a.ts" staged actions={actions} />)
    await waitFor(() => expect(gitDiffFileMock).toHaveBeenCalledWith("/r", "a.ts", true))
    await screen.findByTestId("stub-hunk-unstage")
    await act(async () => {
      fireEvent.click(screen.getByTestId("stub-hunk-unstage"))
    })
    expect(actions.unstage).toHaveBeenCalledWith([], "PATCH")
  })

  it("mounts the per-hunk review list for a working (unstaged) diff", async () => {
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    expect(await screen.findByTestId("hunk-review-list")).toBeInTheDocument()
  })

  it("collapses and re-expands the review list via its toggle", async () => {
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    const list = await screen.findByTestId("hunk-review-list")
    // Expanded by default — the toggle is present and the panel split is used.
    expect(list).toHaveAttribute("data-collapsed", "false")
    expect(screen.getByTestId("resizable-panel-sc-diff-review")).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByTestId("review-collapse-toggle"))
    })
    // Collapsed — no resizable split, only the header bar remains.
    expect(screen.getByTestId("hunk-review-list")).toHaveAttribute("data-collapsed", "true")
    expect(screen.queryByTestId("resizable-panel-sc-diff-review")).not.toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByTestId("review-collapse-toggle"))
    })
    expect(screen.getByTestId("hunk-review-list")).toHaveAttribute("data-collapsed", "false")
  })

  it("does not show the review list for a staged diff", async () => {
    render(<DiffPane rootDir="/r" path="a.ts" staged actions={makeActions()} />)
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-has-diff", "yes")
    )
    expect(screen.queryByTestId("hunk-review-list")).not.toBeInTheDocument()
  })

  it("hides the explain button when the feature is disabled", async () => {
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await screen.findByTestId("diff-viewer-stub")
    expect(screen.queryByTestId("ai-explain-trigger")).not.toBeInTheDocument()
  })

  it("shows the explain button when the feature is enabled", async () => {
    mockSettings = { gitSettings: { explainAI: { enabled: true } } }
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    expect(await screen.findByTestId("ai-explain-trigger")).toBeInTheDocument()
  })

  // The chat could route a user here (the Edit/Write review bridge) but nothing
  // could carry a change back. The control is host-supplied so the standalone
  // source-control route, which has no conversation, does not grow a dead button.
  describe("handing a diff to the chat", () => {
    it("is absent when the host supplies no sink", async () => {
      render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
      await screen.findByTestId("diff-viewer-stub")
      expect(screen.queryByTestId("diff-send-to-chat")).toBeNull()
    })

    it("hands over the path and the concatenated hunk patches", async () => {
      const onSendToChat = jest.fn()
      render(
        <DiffPane
          rootDir="/r"
          path="src/a.ts"
          staged={false}
          actions={makeActions()}
          onSendToChat={onSendToChat}
        />
      )
      fireEvent.click(await screen.findByTestId("diff-send-to-chat"))
      expect(onSendToChat).toHaveBeenCalledWith({ path: "src/a.ts", diffText: "PATCH" })
    })

    // Independent of `explainAI.enabled` — hanging it off that toggle would
    // hide the route to chat behind an unrelated setting.
    it("appears with the Explain setting off", async () => {
      mockSettings = { gitSettings: { explainAI: { enabled: false } } }
      render(
        <DiffPane
          rootDir="/r"
          path="a.ts"
          staged={false}
          actions={makeActions()}
          onSendToChat={jest.fn()}
        />
      )
      expect(await screen.findByTestId("diff-send-to-chat")).toBeInTheDocument()
      expect(screen.queryByTestId("ai-explain-trigger")).toBeNull()
    })

    it("stays hidden for a binary diff, which has no patch text", async () => {
      gitDiffFileMock.mockResolvedValue({
        path: "logo.png",
        oldContent: "",
        newContent: "",
        hunks: [],
        isBinary: true,
      })
      render(
        <DiffPane
          rootDir="/r"
          path="logo.png"
          staged={false}
          actions={makeActions()}
          onSendToChat={jest.fn()}
        />
      )
      await screen.findByTestId("diff-viewer-stub")
      expect(screen.queryByTestId("diff-send-to-chat")).toBeNull()
    })
  })

  it("serves a cached diff without re-fetching", async () => {
    const key = "w:a.ts"
    act(() =>
      useGitStore.getState().cacheDiff(key, {
        path: "a.ts",
        oldContent: "",
        newContent: "",
        hunks: [],
        isBinary: false,
      })
    )
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await screen.findByTestId("diff-viewer-stub")
    expect(gitDiffFileMock).not.toHaveBeenCalled()
  })

  describe("loading, failure and freshness", () => {
    function pending<T>() {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((res) => {
        resolve = res
      })
      return { promise, resolve }
    }
    const diffFor = (path: string) => ({
      path,
      oldContent: "",
      newContent: path,
      hunks: [hunk],
      isBinary: false,
    })

    it("does not mount the viewer, or say 'select a file', while the first diff loads", () => {
      gitDiffFileMock.mockReturnValue(new Promise(() => {}))
      render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
      expect(screen.getByTestId("diff-pane-pending")).toBeInTheDocument()
      expect(screen.queryByTestId("diff-viewer-stub")).not.toBeInTheDocument()
      expect(screen.queryByText(/select a file/i)).not.toBeInTheDocument()
    })

    it("shows the loading line only once the read outlasts the flicker delay", () => {
      jest.useFakeTimers()
      try {
        gitDiffFileMock.mockReturnValue(new Promise(() => {}))
        render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
        expect(screen.queryByTestId("diff-loading-stub")).not.toBeInTheDocument()
        act(() => {
          jest.advanceTimersByTime(250)
        })
        expect(screen.getByTestId("diff-loading-stub")).toBeInTheDocument()
      } finally {
        jest.useRealTimers()
      }
    })

    it("shows the failure with a retry that reads again", async () => {
      gitDiffFileMock
        .mockRejectedValueOnce({ kind: "commandFailed", detail: "bad object" })
        .mockResolvedValueOnce(diffFor("a.ts"))
      render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
      expect(await screen.findByTestId("diff-load-error")).toHaveTextContent("bad object")

      fireEvent.click(screen.getByTestId("diff-load-error-retry"))
      await waitFor(() =>
        expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-has-diff", "yes")
      )
      expect(gitDiffFileMock).toHaveBeenCalledTimes(2)
    })

    it("hides the previous file's diff while the next one loads", async () => {
      const second = pending<ReturnType<typeof diffFor>>()
      gitDiffFileMock.mockImplementation((_root: string, path: string) =>
        path === "a.ts" ? Promise.resolve(diffFor("a.ts")) : second.promise
      )
      const actions = makeActions()
      const { rerender } = render(
        <DiffPane rootDir="/r" path="a.ts" staged={false} actions={actions} />
      )
      await waitFor(() =>
        expect(screen.getByTestId("diff-pane-viewer")).not.toHaveAttribute("aria-hidden")
      )

      rerender(<DiffPane rootDir="/r" path="b.ts" staged={false} actions={actions} />)
      // Still mounted (one Monaco instance), but hidden and inert under b.ts.
      expect(screen.getByTestId("diff-pane-viewer")).toHaveAttribute("aria-hidden", "true")
      expect(screen.getByTestId("diff-pane-pending")).toBeInTheDocument()

      await act(async () => second.resolve(diffFor("b.ts")))
      expect(screen.getByTestId("diff-pane-viewer")).not.toHaveAttribute("aria-hidden")
      expect(screen.queryByTestId("diff-pane-pending")).not.toBeInTheDocument()
    })

    it("re-reads the open file when a status refresh lands (an external edit)", async () => {
      render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
      await waitFor(() => expect(gitDiffFileMock).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(useGitStore.getState().getCachedDiff("w:a.ts")).toBeDefined())

      act(() =>
        useGitStore.getState().setStatus({
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          staged: [],
          changes: [],
          merge: [],
          isRebasing: false,
          isMerging: false,
        })
      )
      await waitFor(() => expect(gitDiffFileMock).toHaveBeenCalledTimes(2))
      // The held diff stays visible while the fresh one is read.
      expect(screen.getByTestId("diff-pane-viewer")).not.toHaveAttribute("aria-hidden")
    })

    it("restarts a read overtaken by a status write, so the older answer is never cached", async () => {
      const stale = pending<ReturnType<typeof diffFor>>()
      const fresh = pending<ReturnType<typeof diffFor>>()
      gitDiffFileMock
        .mockReset()
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(fresh.promise)
      render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
      act(() =>
        useGitStore.getState().setStatus({
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          staged: [],
          changes: [],
          merge: [],
          isRebasing: false,
          isMerging: false,
        })
      )
      expect(gitDiffFileMock).toHaveBeenCalledTimes(2)

      await act(async () => stale.resolve({ ...diffFor("a.ts"), newContent: "before" }))
      expect(useGitStore.getState().getCachedDiff("w:a.ts")).toBeUndefined()

      await act(async () => fresh.resolve({ ...diffFor("a.ts"), newContent: "after" }))
      expect(useGitStore.getState().getCachedDiff("w:a.ts")?.newContent).toBe("after")
    })

    it("does not seed the cache of a repository the user switched to", async () => {
      const slow = pending<ReturnType<typeof diffFor>>()
      gitDiffFileMock.mockReturnValue(slow.promise)
      render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
      act(() => useGitStore.getState().setRootDir("/other"))
      await act(async () => slow.resolve(diffFor("a.ts")))
      expect(useGitStore.getState().getCachedDiff("w:a.ts")).toBeUndefined()
    })
  })

  it("omits every unavailable hunk mutation", async () => {
    const actions = { ...makeActions(), can: jest.fn().mockReturnValue(false) }
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={actions} />)
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-has-diff", "yes")
    )
    expect(screen.queryByTestId("stub-hunk-stage")).not.toBeInTheDocument()
    expect(screen.queryByTestId("stub-hunk-discard")).not.toBeInTheDocument()
    expect(screen.getByTestId("apply-accepted")).toBeDisabled()
  })
})

describe("DiffPane toolbar", () => {
  const withLines: GitHunk = {
    ...hunk,
    lines: [
      { kind: "del", content: "a\n" },
      { kind: "add", content: "b\n" },
      { kind: "add", content: "c\n" },
    ],
  }

  it("names the file, its folder and its counts beside the host's leading controls", async () => {
    gitDiffFileMock.mockResolvedValue({
      path: "src/lib/a.ts",
      oldContent: "",
      newContent: "",
      hunks: [withLines],
      isBinary: false,
    })
    render(
      <DiffPane
        rootDir="/r"
        path="src/lib/a.ts"
        staged={false}
        actions={makeActions()}
        leading={<button data-testid="host-back">back</button>}
      />
    )
    await screen.findByTestId("diff-viewer-stub")
    const start = screen.getByTestId("stub-toolbar-start")
    expect(start).toContainElement(screen.getByTestId("host-back"))
    const identity = screen.getByTestId("diff-file-identity")
    expect(identity).toHaveTextContent("a.ts")
    expect(identity).toHaveTextContent("src/lib")
    expect(identity).toHaveAttribute("title", "src/lib/a.ts")
    expect(screen.getByTestId("diff-file-stats")).toHaveTextContent("+2 -1")
  })

  it("keeps the leading controls on screen while the first diff loads", () => {
    gitDiffFileMock.mockReturnValue(new Promise(() => {}))
    render(
      <DiffPane
        rootDir="/r"
        path="a.ts"
        staged={false}
        actions={makeActions()}
        leading={<button data-testid="host-back">back</button>}
      />
    )
    expect(screen.getByTestId("pending-toolbar")).toContainElement(screen.getByTestId("host-back"))
    // No counts for a file that has not loaded.
    expect(screen.queryByTestId("diff-file-stats")).toBeNull()
  })

  it("opens the file in the host editor at the line the viewer names", async () => {
    const onOpenInEditor = jest.fn()
    render(
      <DiffPane
        rootDir="/r"
        path="a.ts"
        staged={false}
        actions={makeActions()}
        onOpenInEditor={onOpenInEditor}
      />
    )
    await screen.findByTestId("diff-viewer-stub")
    fireEvent.click(screen.getByTestId("stub-open-line"))
    expect(onOpenInEditor).toHaveBeenLastCalledWith("a.ts", 7)
  })

  it("offers no editor jump without a host editor", async () => {
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await screen.findByTestId("diff-viewer-stub")
    expect(screen.queryByTestId("stub-open-line")).toBeNull()
  })

  it("starts the review list collapsed when the host asks for it", async () => {
    render(
      <DiffPane
        rootDir="/r"
        path="a.ts"
        staged={false}
        actions={makeActions()}
        reviewDefaultCollapsed
      />
    )
    expect(await screen.findByTestId("hunk-review-list")).toHaveAttribute("data-collapsed", "true")
  })
})

describe("DiffPane editing and whole-file loading", () => {
  const { readWorkspaceFile, writeWorkspaceFile } = jest.requireMock(
    "@/lib/files/workspace-fs"
  ) as {
    readWorkspaceFile: jest.Mock
    writeWorkspaceFile: jest.Mock
  }
  const { notifyProjectFileSaved } = jest.requireMock("@/lib/files/project-editor-bridge") as {
    notifyProjectFileSaved: jest.Mock
  }
  const { gitReadBlobAtRef } = jest.requireMock("@/lib/git/commands") as {
    gitReadBlobAtRef: jest.Mock
  }

  beforeEach(() => {
    mockFsBackend = true
    mockSaveResult = null
    readWorkspaceFile.mockReset()
    writeWorkspaceFile.mockReset().mockResolvedValue(undefined)
    notifyProjectFileSaved.mockReset()
    gitReadBlobAtRef.mockReset()
  })

  it("lets the reader edit a working-tree diff, keyed per repository and file", async () => {
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await screen.findByTestId("stub-save")
    expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-edit-key", "/r\u0000a.ts")
  })

  it("offers no editing for a staged diff, on touch, without a filesystem, or when the host says no", async () => {
    const { rerender } = render(
      <DiffPane rootDir="/r" path="a.ts" staged actions={makeActions()} />
    )
    await screen.findByTestId("diff-viewer-stub")
    expect(screen.queryByTestId("stub-save")).toBeNull()
    rerender(
      <DiffPane rootDir="/r" path="a.ts" staged={false} density="touch" actions={makeActions()} />
    )
    await screen.findByTestId("diff-viewer-stub")
    expect(screen.queryByTestId("stub-save")).toBeNull()
    rerender(
      <DiffPane rootDir="/r" path="a.ts" staged={false} editable={false} actions={makeActions()} />
    )
    expect(screen.queryByTestId("stub-save")).toBeNull()
    mockFsBackend = false
    rerender(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    expect(screen.queryByTestId("stub-save")).toBeNull()
  })

  it("saves only over the disk text the edit started from, then tells open editors", async () => {
    readWorkspaceFile.mockResolvedValue("disk\n")
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await act(async () => {
      fireEvent.click(await screen.findByTestId("stub-save"))
    })
    await waitFor(() => expect(mockSaveResult).toBe("saved"))
    expect(writeWorkspaceFile).toHaveBeenCalledWith("/r", "a.ts", "mine\n")
    expect(notifyProjectFileSaved).toHaveBeenCalledWith("/r/a.ts")
  })

  it("reports a conflict without writing when the disk moved on, and overwrites when told to", async () => {
    readWorkspaceFile.mockResolvedValue("someone else's\n")
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await act(async () => {
      fireEvent.click(await screen.findByTestId("stub-save"))
    })
    await waitFor(() => expect(mockSaveResult).toBe("conflict"))
    expect(writeWorkspaceFile).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId("stub-save-force"))
    })
    await waitFor(() => expect(mockSaveResult).toBe("saved"))
    expect(writeWorkspaceFile).toHaveBeenCalledWith("/r", "a.ts", "mine\n")
  })

  it("rebuilds an omitted diff's texts from the working file and its hunks", async () => {
    gitDiffFileMock.mockResolvedValue({
      path: "a.ts",
      oldContent: "",
      newContent: "",
      contentOmitted: true,
      isBinary: false,
      hunks: [
        {
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          patch: "P",
          lines: [
            { kind: "del", content: "old\n" },
            { kind: "add", content: "new\n" },
          ],
        },
      ],
    })
    readWorkspaceFile.mockResolvedValue("new\n")
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await act(async () => {
      fireEvent.click(await screen.findByTestId("stub-load-omitted"))
    })
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-omitted", "false")
    )
    expect(readWorkspaceFile).toHaveBeenCalledWith("/r", "a.ts")
    expect(gitReadBlobAtRef).not.toHaveBeenCalled()
    expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-old", "old\n")
    expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-new", "new\n")
  })

  it("offers whole-file loading only for an omitted diff", async () => {
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await screen.findByTestId("diff-viewer-stub")
    expect(screen.queryByTestId("stub-load-omitted")).toBeNull()
  })
})
