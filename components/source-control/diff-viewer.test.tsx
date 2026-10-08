import type { ComponentType } from "react"

const mockRevealLineInCenter = jest.fn()
const mockSetPosition = jest.fn()
const mockFocus = jest.fn()
const mockLayout = jest.fn()
const mockSetMonacoTheme = jest.fn()
const mockAddAction = jest.fn((_action: { id: string; run: () => void }) => ({
  dispose: jest.fn(),
}))
let mockCursorListener: ((e: { position: { lineNumber: number } }) => void) | null = null
let mockContentListener: (() => void) | null = null
let mockShowDynamicLoading = false
let mockModifiedEditorAvailable = true
/** The modified side's buffer, as the fake editor holds it. */
const mockBuffer = { value: "", focused: false }
const mockExecuteEdits = jest.fn((_source: string, edits: { text: string }[]) => {
  mockBuffer.value = edits[0].text
  return true
})
const mockFindRun = jest.fn()
let mockWidth = 0

jest.mock("next/dynamic", () => (_loader: unknown, options?: { loading?: ComponentType }) => {
  const React = jest.requireActual("react")
  // Stand in for the async-loaded Monaco DiffEditor. Fires `onMount` with a
  // fake diff editor so the navigation wiring is exercised, and surfaces the
  // construction options so the view settings can be asserted.
  const Mock = (props: {
    options?: Record<string, unknown>
    onMount?: (editor: unknown, monaco: unknown) => void
  }) => {
    const showLoading = mockShowDynamicLoading && !!options?.loading
    const onMount = props?.onMount
    React.useEffect(() => {
      if (showLoading) return
      const modified = {
        revealLineInCenter: mockRevealLineInCenter,
        setPosition: mockSetPosition,
        focus: mockFocus,
        addAction: mockAddAction,
        onDidChangeCursorPosition: (fn: typeof mockCursorListener) => {
          mockCursorListener = fn
          return { dispose: jest.fn() }
        },
        onDidChangeModelContent: (fn: () => void) => {
          mockContentListener = fn
          return { dispose: jest.fn() }
        },
        hasTextFocus: () => mockBuffer.focused,
        hasWidgetFocus: () => false,
        getValue: () => mockBuffer.value,
        getModel: () => ({ getFullModelRange: () => ({}) }),
        executeEdits: mockExecuteEdits,
        getAction: (id: string) => (id === "actions.find" ? { run: mockFindRun } : null),
      }
      onMount?.(
        {
          layout: mockLayout,
          getModifiedEditor: () => (mockModifiedEditorAvailable ? modified : undefined),
          getOriginalEditor: () => ({ addAction: mockAddAction }),
        },
        {
          editor: { defineTheme: () => {}, setTheme: mockSetMonacoTheme },
          KeyMod: { Alt: 512, Shift: 1024, CtrlCmd: 2048 },
          KeyCode: { F5: 63, KeyS: 49 },
        }
      )
    }, [onMount, showLoading])
    if (showLoading && options?.loading) {
      return React.createElement(options.loading)
    }
    return (
      <div
        data-testid="monaco-diff-mock"
        data-automatic-layout={String(props?.options?.automaticLayout)}
        data-options={JSON.stringify(props?.options ?? {})}
        data-modified={String((props as { modified?: string }).modified ?? "")}
      />
    )
  }
  return Mock
})
jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  DiffEditor: () => <div data-testid="monaco-diff-mock" />,
}))
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
jest.mock("@/lib/canvas/monaco-loader", () => ({ configureMonacoLoader: jest.fn() }))
jest.mock("@/lib/canvas/themes/cognia-active-theme", () => ({
  COGNIA_ACTIVE_THEME_ID: "cognia-active",
  syncCogniaActiveTheme: jest.fn(),
}))
jest.mock("@/lib/canvas/monaco-diff-disposal", () => ({
  guardDiffEditorModelDisposal: jest.fn(),
}))
jest.mock("@/hooks/git/use-source-control-prefs", () => {
  const prefs = {
    diffView: "sideBySide",
    ignoreWhitespace: false,
    collapseUnchanged: true,
    diffWordWrap: false,
  }
  return {
    __prefs: prefs,
    useSourceControlPrefs: () => ({
      prefs,
      setDiffView: jest.fn(),
      setCollapseUnchanged: jest.fn(),
      setDiffWordWrap: jest.fn(),
      setIgnoreWhitespace: jest.fn(),
    }),
  }
})
jest.mock("@/hooks/use-element-width", () => ({ useElementWidth: () => mockWidth }))
// jsdom has no layout; render every virtual row.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 20,
        size: 20,
        end: (index + 1) * 20,
        lane: 0,
      })),
    getTotalSize: () => count * 20,
    measureElement: jest.fn(),
    scrollToIndex: jest.fn(),
  }),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DiffViewer } from "./diff-viewer"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import { guardDiffEditorModelDisposal } from "@/lib/canvas/monaco-diff-disposal"
import { MONACO_DIFF_CHAR_LIMIT } from "@/lib/git/diff-presentation"
import { createRef } from "react"
import { useGitStore } from "@/stores/git/git-store"
import type { DiffViewerHandle } from "./diff-viewer"
import * as prefsModule from "@/hooks/git/use-source-control-prefs"
import type { GitDiff, GitHunk } from "@/types/git"

const mockPrefs = (prefsModule as unknown as { __prefs: Record<string, unknown> }).__prefs

const hunk: GitHunk = {
  header: "@@ -1,2 +1,2 @@",
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 2,
  patch: "PATCH",
  lines: [
    { kind: "del", content: "old\n" },
    { kind: "add", content: "new\n" },
  ],
}
const hunk2: GitHunk = {
  ...hunk,
  header: "@@ -20,2 +20,3 @@",
  oldStart: 20,
  newStart: 20,
  newLines: 3,
  patch: "PATCH2",
}

const diff: GitDiff = {
  path: "a.ts",
  oldContent: "old",
  newContent: "new",
  hunks: [hunk],
  isBinary: false,
  language: "typescript",
}
const twoHunks: GitDiff = { ...diff, hunks: [hunk, hunk2] }

function monacoOptions() {
  return JSON.parse(screen.getByTestId("monaco-diff-mock").getAttribute("data-options")!)
}

describe("DiffViewer", () => {
  afterEach(() => {
    mockShowDynamicLoading = false
    mockModifiedEditorAvailable = true
    mockCursorListener = null
    mockPrefs.diffView = "sideBySide"
    mockPrefs.collapseUnchanged = true
    mockPrefs.diffWordWrap = false
    mockPrefs.ignoreWhitespace = false
    mockContentListener = null
    mockBuffer.value = ""
    mockBuffer.focused = false
    mockWidth = 0
    useGitStore.setState({ diffEdits: {} })
    jest.clearAllMocks()
    jest.useRealTimers()
    Reflect.deleteProperty(globalThis, "ResizeObserver")
  })

  it("shows the empty state with no diff", () => {
    render(<DiffViewer diff={null} staged={false} />)
    expect(screen.getByTestId("diff-empty")).toBeInTheDocument()
  })

  it("shows the binary state, keeping the host's toolbar", () => {
    render(
      <DiffViewer
        diff={{ ...diff, isBinary: true, hunks: [] }}
        staged={false}
        toolbarStart={<span>file.png</span>}
      />
    )
    expect(screen.getByTestId("diff-binary")).toBeInTheDocument()
    expect(screen.getByTestId("diff-toolbar")).toHaveTextContent("file.png")
  })

  it("mounts Monaco and configures the loader", () => {
    render(<DiffViewer diff={diff} staged={false} />)
    expect(screen.getByTestId("monaco-diff-mock")).toBeInTheDocument()
    expect(configureMonacoLoader).toHaveBeenCalled()
  })

  it("renders the async Monaco loading state", () => {
    mockShowDynamicLoading = true
    render(<DiffViewer diff={diff} staged={false} />)
    mockShowDynamicLoading = false
    expect(screen.getAllByRole("status")[0].parentElement).toHaveTextContent("Loading diff")
  })

  it("enables automaticLayout so the editor fills its container", () => {
    render(<DiffViewer diff={diff} staged={false} />)
    expect(screen.getByTestId("monaco-diff-mock")).toHaveAttribute("data-automatic-layout", "true")
  })

  it("feeds the view preferences into Monaco", () => {
    render(<DiffViewer diff={diff} staged={false} />)
    expect(monacoOptions()).toMatchObject({
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      hideUnchangedRegions: { enabled: true },
      wordWrap: "off",
    })
  })

  it("never mounts Monaco on touch: the line view, inline and wrapped", () => {
    mockPrefs.collapseUnchanged = false
    mockWidth = 2000
    render(<DiffViewer diff={diff} staged={false} density="touch" />)
    expect(screen.queryByTestId("monaco-diff-mock")).toBeNull()
    expect(screen.getByTestId("diff-viewer")).toHaveAttribute("data-view", "lines")
    const lines = screen.getByTestId("diff-lines-view")
    expect(lines).toHaveAttribute("data-wrap", "true")
    expect(lines).toHaveAttribute("data-layout", "unified")
    // A diff of the full texts, not the hunks: no hunk header rows.
    expect(screen.queryByTestId("line-diff-header")).toBeNull()
    expect(screen.getAllByTestId("line-diff-line").map((l) => l.textContent)).toEqual([
      expect.stringContaining("old"),
      expect.stringContaining("new"),
    ])
    // Nothing to load on a phone: no banner for an ordinary diff.
    expect(screen.queryByTestId("diff-large-banner")).toBeNull()
  })

  it("guards diff model disposal on mount (monaco-react dispose-order bug)", () => {
    render(<DiffViewer diff={diff} staged={false} />)
    expect(guardDiffEditorModelDisposal).toHaveBeenCalledWith(
      expect.objectContaining({ getModifiedEditor: expect.any(Function) })
    )
  })

  it("applies the cognia-active theme so light/dark matches the app", () => {
    render(<DiffViewer diff={diff} staged={false} />)
    expect(mockSetMonacoTheme).toHaveBeenCalledWith("cognia-active")
  })

  it("hides the toolbar for a client diff with nothing to navigate", () => {
    render(<DiffViewer diff={{ ...diff, hunks: [] }} staged={false} />)
    expect(screen.queryByTestId("diff-toolbar")).toBeNull()
  })

  it("renders host slots around the navigator in one toolbar", () => {
    render(
      <DiffViewer
        diff={diff}
        staged={false}
        toolbarStart={<span data-testid="start-slot" />}
        toolbarEnd={<span data-testid="end-slot" />}
      />
    )
    const toolbar = screen.getByTestId("diff-toolbar")
    expect(toolbar).toContainElement(screen.getByTestId("start-slot"))
    expect(toolbar).toContainElement(screen.getByTestId("hunk-nav"))
    expect(toolbar).toContainElement(screen.getByTestId("end-slot"))
  })

  describe("change navigator", () => {
    it("starts before the first change, then steps through them", () => {
      render(<DiffViewer diff={twoHunks} staged={false} />)
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("–/2")
      expect(screen.getByTestId("hunk-position")).toHaveAccessibleName("2 hunks")
      fireEvent.click(screen.getByTestId("hunk-next"))
      expect(mockRevealLineInCenter).toHaveBeenLastCalledWith(1)
      expect(mockSetPosition).toHaveBeenLastCalledWith({ lineNumber: 1, column: 1 })
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("1/2")
      expect(screen.getByTestId("hunk-prev")).toBeDisabled()
      fireEvent.click(screen.getByTestId("hunk-next"))
      expect(mockRevealLineInCenter).toHaveBeenLastCalledWith(20)
      expect(screen.getByTestId("hunk-next")).toBeDisabled()
      fireEvent.click(screen.getByTestId("hunk-prev"))
      expect(mockRevealLineInCenter).toHaveBeenLastCalledWith(1)
    })

    it("follows the Monaco caret to the change it is in", () => {
      render(<DiffViewer diff={twoHunks} staged={false} />)
      act(() => mockCursorListener?.({ position: { lineNumber: 21 } }))
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("2/2")
    })

    it("runs the current-change actions against the change the reader is on", () => {
      const onClick = jest.fn()
      render(
        <DiffViewer
          diff={twoHunks}
          staged={false}
          hunkActions={[{ icon: "stage", label: "Stage Hunk", onClick }]}
        />
      )
      const stage = screen.getByRole("button", { name: "Stage Hunk" })
      // Nothing picked yet: the action has no target.
      expect(stage).toBeDisabled()
      act(() => mockCursorListener?.({ position: { lineNumber: 20 } }))
      fireEvent.click(stage)
      expect(onClick).toHaveBeenCalledWith(hunk2)
    })

    it("uses touch-sized controls in touch density", () => {
      render(
        <DiffViewer
          diff={diff}
          staged={false}
          density="touch"
          hunkActions={[{ icon: "stage", label: "Stage Hunk", onClick: jest.fn() }]}
        />
      )
      expect(screen.getByTestId("hunk-stage")).toHaveClass("size-11")
      expect(screen.getByTestId("hunk-next")).toHaveClass("size-11")
      expect(screen.getByTestId("diff-toolbar")).toHaveClass("min-h-12")
    })

    it("moves between changes with Alt+F5 / Shift+Alt+F5", () => {
      render(<DiffViewer diff={twoHunks} staged={false} />)
      const root = screen.getByTestId("diff-viewer")
      fireEvent.keyDown(root, { key: "F5", altKey: true })
      fireEvent.keyDown(root, { key: "F5", altKey: true })
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("2/2")
      fireEvent.keyDown(root, { key: "F5", altKey: true, shiftKey: true })
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("1/2")
      // Plain F5 is left alone.
      fireEvent.keyDown(root, { key: "F5" })
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("1/2")
    })

    it("registers the same chords inside both Monaco editors", () => {
      render(<DiffViewer diff={twoHunks} staged={false} />)
      const ids = mockAddAction.mock.calls.map(([action]) => action.id)
      expect(ids.filter((id) => id === "cognia.diff.nextChange")).toHaveLength(2)
      expect(ids.filter((id) => id === "cognia.diff.previousChange")).toHaveLength(2)
      const next = mockAddAction.mock.calls.find(([a]) => a.id === "cognia.diff.nextChange")![0]
      act(() => next.run())
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("1/2")
    })

    it("tolerates navigation before Monaco's modified editor is ready", () => {
      mockModifiedEditorAvailable = false
      render(<DiffViewer diff={{ ...diff, language: undefined }} staged={false} />)
      expect(() => fireEvent.click(screen.getByTestId("hunk-next"))).not.toThrow()
    })

    it("opens the file at the current change", () => {
      const onOpenLine = jest.fn()
      render(<DiffViewer diff={twoHunks} staged={false} onOpenLine={onOpenLine} />)
      // Before any change is picked, the first one.
      fireEvent.click(screen.getByTestId("hunk-open-in-editor"))
      expect(onOpenLine).toHaveBeenLastCalledWith(1)
      act(() => mockCursorListener?.({ position: { lineNumber: 20 } }))
      fireEvent.click(screen.getByTestId("hunk-open-in-editor"))
      expect(onOpenLine).toHaveBeenLastCalledWith(20)
    })

    it("resets to the top when the file changes", () => {
      const { rerender } = render(<DiffViewer diff={twoHunks} staged={false} />)
      fireEvent.click(screen.getByTestId("hunk-next"))
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("1/2")
      rerender(<DiffViewer diff={{ ...twoHunks, path: "b.ts" }} staged={false} />)
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("–/2")
    })
  })

  describe("large diffs", () => {
    const big = "x".repeat(MONACO_DIFF_CHAR_LIMIT)

    it("opens the line view instead of Monaco, with a way to load the full diff", () => {
      render(<DiffViewer diff={{ ...twoHunks, oldContent: big }} staged={false} />)
      expect(screen.queryByTestId("monaco-diff-mock")).toBeNull()
      expect(screen.getByTestId("diff-viewer")).toHaveAttribute("data-view", "lines")
      expect(screen.getByTestId("diff-large-banner")).toBeInTheDocument()
      // The full texts are here, so the line view diffs them (every line,
      // expandable) rather than showing git's hunks.
      expect(screen.queryByTestId("line-diff-header")).toBeNull()
      expect(screen.getAllByTestId("line-diff-line")).toHaveLength(2)
      fireEvent.click(screen.getByTestId("diff-load-full"))
      expect(screen.getByTestId("monaco-diff-mock")).toBeInTheDocument()
    })

    it("forgets 'load full' when a different file opens", () => {
      const { rerender } = render(
        <DiffViewer diff={{ ...twoHunks, oldContent: big }} staged={false} />
      )
      fireEvent.click(screen.getByTestId("diff-load-full"))
      rerender(<DiffViewer diff={{ ...twoHunks, oldContent: big, path: "b.ts" }} staged={false} />)
      expect(screen.getByTestId("diff-viewer")).toHaveAttribute("data-view", "lines")
    })

    it("shows only hunks when the host omitted the full texts", () => {
      render(
        <DiffViewer
          diff={{ ...twoHunks, oldContent: "", newContent: "", contentOmitted: true }}
          staged={false}
        />
      )
      expect(screen.getByTestId("diff-large-banner")).toHaveTextContent(/too large/)
      expect(screen.queryByTestId("diff-load-full")).toBeNull()
      // No host to rebuild the texts: no button promising it.
      expect(screen.queryByTestId("diff-load-omitted")).toBeNull()
      expect(screen.getAllByTestId("line-diff-line")).toHaveLength(4)
      expect(screen.getAllByTestId("line-diff-header")).toHaveLength(2)
    })

    it("asks the host for the whole file and says so when that fails", async () => {
      let reject: (e: Error) => void = () => {}
      const onLoadOmitted = jest.fn(
        () =>
          new Promise<void>((_resolve, rej) => {
            reject = rej
          })
      )
      render(
        <DiffViewer
          diff={{ ...twoHunks, oldContent: "", newContent: "", contentOmitted: true }}
          staged={false}
          onLoadOmitted={onLoadOmitted}
        />
      )
      fireEvent.click(screen.getByTestId("diff-load-omitted"))
      expect(onLoadOmitted).toHaveBeenCalled()
      expect(screen.getByTestId("diff-load-omitted")).toBeDisabled()
      await act(async () => reject(new Error("stale")))
      expect(screen.getByTestId("diff-large-banner")).toHaveTextContent(
        /Couldn't load the whole file/
      )
      expect(screen.getByTestId("diff-load-omitted")).not.toBeDisabled()
    })

    it("cannot ignore whitespace in git's hunk view", async () => {
      const user = userEvent.setup()
      render(
        <DiffViewer
          diff={{ ...twoHunks, oldContent: "", newContent: "", contentOmitted: true }}
          staged={false}
        />
      )
      await user.click(screen.getByRole("button", { name: "Diff view options" }))
      expect(await screen.findByTestId("diff-view-whitespace")).toHaveAttribute("data-disabled")
    })

    it("diffs a large client-built diff without hunks in the lightweight view", () => {
      const old = Array.from({ length: 30_000 }, (_, i) => `l${i}`).join("\n")
      const next = old.replace("l15000", "changed")
      render(
        <DiffViewer
          diff={{ ...diff, hunks: [], oldContent: old, newContent: next }}
          staged={false}
        />
      )
      const lines = screen.getAllByTestId("line-diff-line")
      expect(lines.filter((l) => l.getAttribute("data-type") !== "unchanged")).toHaveLength(2)
    })

    it("opens the file at a line from the lightweight view's gutter", () => {
      const onOpenLine = jest.fn()
      render(
        <DiffViewer
          diff={{ ...twoHunks, oldContent: "", newContent: "", contentOmitted: true }}
          staged={false}
          onOpenLine={onOpenLine}
        />
      )
      fireEvent.click(screen.getAllByTestId("line-diff-open")[1])
      expect(onOpenLine).toHaveBeenCalledWith(1)
    })

    it("steps through hunks in the lightweight view", () => {
      render(
        <DiffViewer
          diff={{ ...twoHunks, oldContent: "", newContent: "", contentOmitted: true }}
          staged={false}
        />
      )
      fireEvent.click(screen.getByTestId("hunk-next"))
      fireEvent.click(screen.getByTestId("hunk-next"))
      expect(screen.getByTestId("hunk-position")).toHaveTextContent("2/2")
      expect(mockRevealLineInCenter).not.toHaveBeenCalled()
    })
  })

  it("exposes the view options in the toolbar menu", async () => {
    const user = userEvent.setup()
    render(<DiffViewer diff={diff} staged={false} />)
    await user.click(screen.getByRole("button", { name: "Diff view options" }))
    expect(await screen.findByTestId("diff-view-side-by-side")).toBeInTheDocument()
    expect(screen.getByTestId("diff-view-collapse")).toHaveAttribute("data-state", "checked")
    expect(screen.getByTestId("diff-view-wrap")).toHaveAttribute("data-state", "unchecked")
  })

  it("lays out Monaco after a container resize and disconnects on unmount", () => {
    jest.useFakeTimers()
    let resize: ResizeObserverCallback | null = null
    const disconnect = jest.fn()
    const observe = jest.fn()
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe = observe
      disconnect = disconnect
      unobserve = jest.fn()
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: MockResizeObserver,
    })

    const { unmount } = render(<DiffViewer diff={diff} staged={false} />)
    expect(observe).toHaveBeenCalled()
    act(() => {
      resize?.([], {} as ResizeObserver)
      resize?.([], {} as ResizeObserver)
      jest.advanceTimersByTime(60)
    })
    expect(mockLayout).toHaveBeenCalled()

    act(() => resize?.([], {} as ResizeObserver))
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})

describe("DiffViewer line view", () => {
  afterEach(() => {
    mockWidth = 0
    mockPrefs.diffView = "sideBySide"
    mockPrefs.ignoreWhitespace = false
    jest.clearAllMocks()
  })

  const big = "x".repeat(MONACO_DIFF_CHAR_LIMIT)

  it("lays a wide desktop line view side by side, a narrow one inline", () => {
    mockWidth = 1000
    const { rerender } = render(
      <DiffViewer diff={{ ...diff, oldContent: big, newContent: "y" }} staged={false} />
    )
    expect(screen.getByTestId("diff-lines-view")).toHaveAttribute("data-layout", "split")
    mockWidth = 500
    rerender(<DiffViewer diff={{ ...diff, oldContent: big, newContent: "z" }} staged={false} />)
    expect(screen.getByTestId("diff-lines-view")).toHaveAttribute("data-layout", "unified")
  })

  it("re-diffs the full texts ignoring whitespace when asked", () => {
    mockPrefs.ignoreWhitespace = true
    render(
      <DiffViewer
        diff={{ ...diff, hunks: [], oldContent: `  a\n${big}`, newContent: `a\n${big}` }}
        staged={false}
      />
    )
    // Nothing changed once indentation is ignored: one folded run, no changes.
    expect(
      screen
        .queryAllByTestId("line-diff-line")
        .filter((l) => l.getAttribute("data-type") !== "unchanged")
    ).toHaveLength(0)
    expect(screen.getByTestId("line-diff-gap")).toBeInTheDocument()
  })

  it("opens find in the line view from the toolbar", () => {
    render(<DiffViewer diff={{ ...twoHunks, oldContent: big }} staged={false} />)
    fireEvent.click(screen.getByTestId("diff-find"))
    expect(screen.getByTestId("line-diff-find")).toBeInTheDocument()
  })

  it("opens Monaco's own find widget in the editor view", () => {
    render(<DiffViewer diff={twoHunks} staged={false} />)
    fireEvent.click(screen.getByTestId("diff-find"))
    expect(mockFindRun).toHaveBeenCalled()
  })
})

describe("DiffViewer current change", () => {
  afterEach(() => jest.clearAllMocks())

  it("reports the change the reader is on and reveals one on request", () => {
    const onCurrentChange = jest.fn()
    const ref = createRef<DiffViewerHandle>()
    render(
      <DiffViewer ref={ref} diff={twoHunks} staged={false} onCurrentChange={onCurrentChange} />
    )
    expect(onCurrentChange).toHaveBeenLastCalledWith(-1)
    act(() => ref.current!.revealHunk(1))
    expect(mockRevealLineInCenter).toHaveBeenLastCalledWith(20)
    expect(onCurrentChange).toHaveBeenLastCalledWith(1)
  })
})

describe("DiffViewer editing", () => {
  const KEY = "/r\u0000a.ts"
  const editable: GitDiff = { ...diff, oldContent: "old\n", newContent: "disk\n" }

  function binding(outcome: "saved" | "conflict" = "saved") {
    return { draftKey: KEY, save: jest.fn(async () => outcome) }
  }

  /** The reader types `text` into the modified side. */
  function type(text: string) {
    mockBuffer.focused = true
    mockBuffer.value = text
    act(() => {
      mockContentListener?.()
      jest.advanceTimersByTime(200)
    })
    mockBuffer.focused = false
  }

  beforeEach(() => {
    jest.useFakeTimers()
    useGitStore.setState({ diffEdits: {} })
    mockBuffer.value = "disk\n"
    mockBuffer.focused = false
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it("makes only an unstaged diff's modified side editable", () => {
    const { rerender } = render(<DiffViewer diff={editable} staged={false} edit={binding()} />)
    expect(monacoOptions()).toMatchObject({ readOnly: false, originalEditable: false })
    expect(screen.getByTestId("diff-viewer")).toHaveAttribute("data-editable", "true")
    rerender(<DiffViewer diff={editable} staged edit={binding()} />)
    expect(monacoOptions()).toMatchObject({ readOnly: true })
    rerender(<DiffViewer diff={editable} staged={false} />)
    expect(monacoOptions()).toMatchObject({ readOnly: true })
  })

  it("keeps typed text as a draft and saves it against the disk text it started from", async () => {
    const edit = binding()
    render(<DiffViewer diff={editable} staged={false} edit={edit} />)
    type("mine\n")
    expect(useGitStore.getState().diffEdits[KEY]).toEqual({ content: "mine\n", base: "disk\n" })
    expect(screen.getByTestId("diff-edit-dirty")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId("diff-edit-save"))
    })
    expect(edit.save).toHaveBeenCalledWith("mine\n", "disk\n")
    expect(useGitStore.getState().diffEdits[KEY]).toBeUndefined()
    expect(screen.queryByTestId("diff-edit-controls")).toBeNull()
    // Until the refreshed diff arrives, Monaco keeps the saved text.
    expect(screen.getByTestId("monaco-diff-mock")).toHaveAttribute("data-modified", "mine\n")
  })

  it("ignores edits it did not see the reader make", () => {
    render(<DiffViewer diff={editable} staged={false} edit={binding()} />)
    mockBuffer.value = "synced by monaco\n"
    act(() => {
      mockContentListener?.()
      jest.advanceTimersByTime(200)
    })
    expect(useGitStore.getState().diffEdits[KEY]).toBeUndefined()
  })

  it("drops the draft when the reader types the disk text back", () => {
    render(<DiffViewer diff={editable} staged={false} edit={binding()} />)
    type("mine\n")
    type("disk\n")
    expect(useGitStore.getState().diffEdits[KEY]).toBeUndefined()
  })

  it("asks before overwriting a file that changed on disk", async () => {
    const edit = binding("conflict")
    render(<DiffViewer diff={editable} staged={false} edit={edit} />)
    type("mine\n")
    await act(async () => {
      fireEvent.click(screen.getByTestId("diff-edit-save"))
    })
    expect(screen.getByTestId("diff-edit-banner")).toHaveAttribute("data-issue", "conflict")
    edit.save.mockResolvedValueOnce("saved")
    await act(async () => {
      fireEvent.click(screen.getByTestId("diff-edit-overwrite"))
    })
    expect(edit.save).toHaveBeenLastCalledWith("mine\n", null)
    expect(useGitStore.getState().diffEdits[KEY]).toBeUndefined()
  })

  it("keeps the buffer through a refresh and flags a disk that moved on", () => {
    const edit = binding()
    const { rerender } = render(<DiffViewer diff={editable} staged={false} edit={edit} />)
    type("mine\n")
    rerender(
      <DiffViewer diff={{ ...editable, newContent: "theirs\n" }} staged={false} edit={edit} />
    )
    // Monaco is still handed the text the edit started from.
    expect(screen.getByTestId("monaco-diff-mock")).toHaveAttribute("data-modified", "disk\n")
    expect(screen.getByTestId("diff-edit-banner")).toHaveAttribute("data-issue", "diskMoved")
    fireEvent.click(screen.getByTestId("diff-edit-discard"))
    expect(mockExecuteEdits).toHaveBeenLastCalledWith("cognia.diff.revert", [
      expect.objectContaining({ text: "theirs\n" }),
    ])
    expect(useGitStore.getState().diffEdits[KEY]).toBeUndefined()
  })

  it("says so when the write fails and keeps the edits", async () => {
    const edit = { draftKey: KEY, save: jest.fn(async () => Promise.reject(new Error("EACCES"))) }
    render(<DiffViewer diff={editable} staged={false} edit={edit} />)
    type("mine\n")
    await act(async () => {
      fireEvent.click(screen.getByTestId("diff-edit-save"))
    })
    expect(screen.getByTestId("diff-edit-banner")).toHaveAttribute("data-issue", "failed")
    expect(useGitStore.getState().diffEdits[KEY]).toEqual({ content: "mine\n", base: "disk\n" })
  })

  it("puts a stored draft back on top of the disk text when the file opens", () => {
    useGitStore.setState({ diffEdits: { [KEY]: { content: "draft\n", base: "disk\n" } } })
    render(<DiffViewer diff={editable} staged={false} edit={binding()} />)
    expect(mockExecuteEdits).toHaveBeenCalledWith("cognia.diff.restoreDraft", [
      expect.objectContaining({ text: "draft\n" }),
    ])
    expect(screen.getByTestId("diff-edit-controls")).toBeInTheDocument()
  })

  it("binds Ctrl/Cmd+S in the editor to save", async () => {
    const edit = binding()
    render(<DiffViewer diff={editable} staged={false} edit={edit} />)
    type("mine\n")
    const saveAction = mockAddAction.mock.calls.find(([a]) => a.id === "cognia.diff.save")![0]
    await act(async () => saveAction.run())
    expect(edit.save).toHaveBeenCalledWith("mine\n", "disk\n")
  })
})
