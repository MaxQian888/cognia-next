jest.mock("next/dynamic", () => () => {
  // Surface the construction options so we can assert Monaco gets
  // `automaticLayout: true` (the fix for the tiny-editor sizing bug).
  const Mock = (props: { options?: { automaticLayout?: boolean } }) => (
    <div
      data-testid="monaco-diff-mock"
      data-automatic-layout={String(props?.options?.automaticLayout)}
    />
  )
  return Mock
})
jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  DiffEditor: () => <div data-testid="monaco-diff-mock" />,
}))
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }))
jest.mock("@/lib/canvas/monaco-loader", () => ({ configureMonacoLoader: jest.fn() }))

import { fireEvent, render, screen } from "@testing-library/react"
import { ConflictResolver, mergeBoth } from "./conflict-resolver"
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
