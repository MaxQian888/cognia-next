const mockRevealLineInCenter = jest.fn()
const mockSetPosition = jest.fn()
const mockFocus = jest.fn()
const mockSetMonacoTheme = jest.fn()

jest.mock("next/dynamic", () => () => {
  const React = jest.requireActual("react")
  // Stand in for the async-loaded Monaco DiffEditor. Fires `onMount` with a
  // fake diff editor so the jump-to-hunk wiring is exercised, and surfaces the
  // construction options so we can assert `automaticLayout: true`.
  const Mock = (props: {
    options?: { automaticLayout?: boolean }
    onMount?: (editor: unknown, monaco: unknown) => void
  }) => {
    const onMount = props?.onMount
    React.useEffect(() => {
      onMount?.(
        {
          getModifiedEditor: () => ({
            revealLineInCenter: mockRevealLineInCenter,
            setPosition: mockSetPosition,
            focus: mockFocus,
          }),
        },
        { editor: { defineTheme: () => {}, setTheme: mockSetMonacoTheme } }
      )
    }, [onMount])
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

import { fireEvent, render, screen } from "@testing-library/react"
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
})
