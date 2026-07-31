import type { ComponentType } from "react"

const mockRevealLineInCenter = jest.fn()
const mockSetPosition = jest.fn()
const mockFocus = jest.fn()
const mockLayout = jest.fn()
const mockSetMonacoTheme = jest.fn()
let mockShowDynamicLoading = false
let mockModifiedEditorAvailable = true

jest.mock("next/dynamic", () => (_loader: unknown, options?: { loading?: ComponentType }) => {
  const React = jest.requireActual("react")
  // Stand in for the async-loaded Monaco DiffEditor. Fires `onMount` with a
  // fake diff editor so the jump-to-hunk wiring is exercised, and surfaces the
  // construction options so we can assert `automaticLayout: true`.
  const Mock = (props: {
    options?: { automaticLayout?: boolean }
    onMount?: (editor: unknown, monaco: unknown) => void
  }) => {
    const showLoading = mockShowDynamicLoading && !!options?.loading
    const onMount = props?.onMount
    React.useEffect(() => {
      if (showLoading) return
      onMount?.(
        {
          layout: mockLayout,
          getModifiedEditor: () =>
            mockModifiedEditorAvailable
              ? {
                  revealLineInCenter: mockRevealLineInCenter,
                  setPosition: mockSetPosition,
                  focus: mockFocus,
                }
              : undefined,
        },
        { editor: { defineTheme: () => {}, setTheme: mockSetMonacoTheme } }
      )
    }, [onMount, showLoading])
    if (showLoading && options?.loading) {
      return React.createElement(options.loading)
    }
    return (
      <div
        data-testid="monaco-diff-mock"
        data-automatic-layout={String(props?.options?.automaticLayout)}
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

import { act, fireEvent, render, screen } from "@testing-library/react"
import { DiffViewer } from "./diff-viewer"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import { guardDiffEditorModelDisposal } from "@/lib/canvas/monaco-diff-disposal"
import type { GitDiff, GitHunk } from "@/types/git"

const hunk: GitHunk = {
  header: "@@ -1,2 +1,2 @@",
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 2,
  patch: "PATCH",
  lines: [],
}

const diff: GitDiff = {
  path: "a.ts",
  oldContent: "old",
  newContent: "new",
  hunks: [hunk],
  isBinary: false,
  language: "typescript",
}

describe("DiffViewer", () => {
  afterEach(() => {
    mockShowDynamicLoading = false
    mockModifiedEditorAvailable = true
    jest.useRealTimers()
    Reflect.deleteProperty(globalThis, "ResizeObserver")
  })

  it("shows the empty state with no diff", () => {
    render(<DiffViewer diff={null} staged={false} />)
    expect(screen.getByTestId("diff-empty")).toBeInTheDocument()
  })

  it("shows the binary state", () => {
    render(<DiffViewer diff={{ ...diff, isBinary: true, hunks: [] }} staged={false} />)
    expect(screen.getByTestId("diff-binary")).toBeInTheDocument()
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
    expect(screen.getByRole("status").parentElement).toHaveTextContent("Loading diff")
  })

  it("enables automaticLayout so the editor fills its container", () => {
    render(<DiffViewer diff={diff} staged={false} />)
    expect(screen.getByTestId("monaco-diff-mock")).toHaveAttribute("data-automatic-layout", "true")
  })

  it("renders per-hunk actions and fires them with the hunk", () => {
    const onClick = jest.fn()
    render(
      <DiffViewer
        diff={diff}
        staged={false}
        hunkActions={[{ icon: "stage", label: "Stage Hunk", onClick }]}
      />
    )
    fireEvent.click(screen.getByTestId("hunk-stage-0"))
    expect(onClick).toHaveBeenCalledWith(hunk)
  })

  it("uses touch-sized hunk controls in touch density", () => {
    render(
      <DiffViewer
        diff={diff}
        staged={false}
        density="touch"
        hunkActions={[{ icon: "stage", label: "Stage Hunk", onClick: jest.fn() }]}
      />
    )

    expect(screen.getByTestId("hunk-stage-0")).toHaveClass("size-11")
    expect(screen.getByTestId("hunk-jump-0")).toHaveClass("min-h-11")
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

  it("jumps the modified editor to the hunk's line when its chip is clicked", () => {
    render(
      <DiffViewer
        diff={diff}
        staged={false}
        hunkActions={[{ icon: "stage", label: "Stage Hunk", onClick: jest.fn() }]}
      />
    )
    fireEvent.click(screen.getByTestId("hunk-jump-0"))
    expect(mockRevealLineInCenter).toHaveBeenCalledWith(hunk.newStart)
    expect(mockSetPosition).toHaveBeenCalledWith({ lineNumber: hunk.newStart, column: 1 })
  })

  it("tolerates a hunk jump before Monaco's modified editor is ready", () => {
    mockModifiedEditorAvailable = false
    render(
      <DiffViewer
        diff={{ ...diff, language: undefined }}
        staged={false}
        hunkActions={[{ icon: "stage", label: "Stage Hunk", onClick: jest.fn() }]}
      />
    )

    expect(() => fireEvent.click(screen.getByTestId("hunk-jump-0"))).not.toThrow()
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
