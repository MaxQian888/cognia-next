jest.mock("next/dynamic", () => () => {
  const Mock = () => <div data-testid="monaco-diff-mock" />
  return Mock
})
jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  DiffEditor: () => <div data-testid="monaco-diff-mock" />,
}))
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
jest.mock("@/lib/canvas/monaco-loader", () => ({ configureMonacoLoader: jest.fn() }))

import { fireEvent, render, screen } from "@testing-library/react"
import { DiffViewer } from "./diff-viewer"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import type { GitDiff, GitHunk } from "@/lib/git/types"

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
})
