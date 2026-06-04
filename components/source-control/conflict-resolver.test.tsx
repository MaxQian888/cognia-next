jest.mock("next/dynamic", () => () => {
  const React = jest.requireActual("react")
  // Surface the construction options so we can assert Monaco gets
  // `automaticLayout: true` (the fix for the tiny-editor sizing bug), and fire
  // `onMount` with a fake diff editor so the mount wiring is exercised.
  const Mock = (props: {
    options?: { automaticLayout?: boolean }
    onMount?: (editor: unknown, monaco: unknown) => void
  }) => {
    const onMount = props?.onMount
    React.useEffect(() => {
      onMount?.(
        { getModifiedEditor: () => ({}) },
        { editor: { defineTheme: () => {}, setTheme: () => {} } }
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
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }))
jest.mock("@/lib/canvas/monaco-loader", () => ({ configureMonacoLoader: jest.fn() }))
jest.mock("@/lib/canvas/themes/cognia-active-theme", () => ({
  COGNIA_ACTIVE_THEME_ID: "cognia-active",
  syncCogniaActiveTheme: jest.fn(),
}))
jest.mock("@/lib/canvas/monaco-diff-disposal", () => ({
  guardDiffEditorModelDisposal: jest.fn(),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { ConflictResolver, mergeBoth } from "./conflict-resolver"
import { guardDiffEditorModelDisposal } from "@/lib/canvas/monaco-diff-disposal"
import type { GitConflict } from "@/types/git"

const conflict: GitConflict = {
  path: "a.ts",
  ours: "ours line\n",
  theirs: "theirs line\n",
  base: "base\n",
}

describe("ConflictResolver", () => {
  it("renders the conflicted path and accept buttons", () => {
    render(<ConflictResolver conflict={conflict} onResolve={() => {}} />)
    expect(screen.getByText("a.ts")).toBeInTheDocument()
    expect(screen.getByTestId("accept-ours")).toBeInTheDocument()
    expect(screen.getByTestId("accept-theirs")).toBeInTheDocument()
    expect(screen.getByTestId("accept-both")).toBeInTheDocument()
  })

  it("enables automaticLayout so the editor fills its container", () => {
    render(<ConflictResolver conflict={conflict} onResolve={() => {}} />)
    expect(screen.getByTestId("monaco-diff-mock")).toHaveAttribute("data-automatic-layout", "true")
  })

  it("guards diff model disposal on mount (monaco-react dispose-order bug)", () => {
    render(<ConflictResolver conflict={conflict} onResolve={() => {}} />)
    expect(guardDiffEditorModelDisposal).toHaveBeenCalledWith(
      expect.objectContaining({ getModifiedEditor: expect.any(Function) })
    )
  })

  it("resolves with a single side", () => {
    const onResolve = jest.fn()
    render(<ConflictResolver conflict={conflict} onResolve={onResolve} />)
    fireEvent.click(screen.getByTestId("accept-ours"))
    expect(onResolve).toHaveBeenCalledWith({ side: "ours" })
    fireEvent.click(screen.getByTestId("accept-theirs"))
    expect(onResolve).toHaveBeenCalledWith({ side: "theirs" })
  })

  it("accept both sends the merged buffer", () => {
    const onResolve = jest.fn()
    render(<ConflictResolver conflict={conflict} onResolve={onResolve} />)
    fireEvent.click(screen.getByTestId("accept-both"))
    expect(onResolve).toHaveBeenCalledWith({ mergedContent: "ours line\ntheirs line\n" })
  })
})

describe("mergeBoth", () => {
  it("joins ours then theirs, ensuring a separating newline", () => {
    expect(mergeBoth({ path: "x", ours: "a", theirs: "b", base: null })).toBe("a\nb")
    expect(mergeBoth({ path: "x", ours: "a\n", theirs: "b", base: null })).toBe("a\nb")
  })
})
