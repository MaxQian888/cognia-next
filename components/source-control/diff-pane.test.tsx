jest.mock("@/lib/git/commands", () => ({ gitDiffFile: jest.fn() }))
let mockSettings: unknown = { gitSettings: {} }
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
  }: {
    diff: unknown
    hunkActions?: { icon: string; onClick: (h: unknown) => void }[]
  }) => (
    <div data-testid="diff-viewer-stub" data-has-diff={diff ? "yes" : "no"}>
      {(hunkActions ?? []).map((a) => (
        <button key={a.icon} data-testid={`stub-hunk-${a.icon}`} onClick={() => a.onClick(hunk)}>
          {a.icon}
        </button>
      ))}
    </div>
  ),
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
  act(() => useGitStore.getState().reset())
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
    await screen.findByTestId("diff-viewer-stub")
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
})
