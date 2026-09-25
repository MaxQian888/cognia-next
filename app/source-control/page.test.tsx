/**
 * @jest-environment jsdom
 */

jest.mock("@/components/source-control/source-control-panel", () => ({
  SourceControlPanel: () => <div data-testid="sc-desktop-stub" />,
}))
jest.mock("@/components/mobile/source-control/source-control-mobile-body", () => ({
  SourceControlMobileBody: ({ initialDiffOpen }: { initialDiffOpen?: boolean }) => (
    <div data-testid="sc-mobile-stub" data-initial-diff-open={String(Boolean(initialDiffOpen))} />
  ),
}))

const compactMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => compactMock(),
}))

let params = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useSearchParams: () => params,
}))

import { act, render, screen } from "@testing-library/react"
import SourceControlPage from "./page"
import { useGitStore } from "@/stores/git/git-store"

beforeEach(() => {
  params = new URLSearchParams()
  compactMock.mockReset().mockReturnValue(false)
  act(() => useGitStore.getState().reset())
  act(() => useGitStore.getState().setRootDir(null))
})

describe("SourceControlPage", () => {
  it("mounts the desktop panel on a wide screen and the compact body on a phone", () => {
    const { unmount } = render(<SourceControlPage />)
    expect(screen.getByTestId("sc-desktop-stub")).toBeInTheDocument()
    unmount()

    compactMock.mockReturnValue(true)
    render(<SourceControlPage />)
    expect(screen.getByTestId("sc-mobile-stub")).toBeInTheDocument()
  })

  /**
   * The ⌘K git rows navigate here with `?root=`. Without this the link is
   * dormant: the row would land on Source Control showing whichever tree the
   * panel happened to be bound to, which for a branch held in another worktree
   * is the wrong one.
   */
  it("binds the panel to the repository named in ?root=", () => {
    params = new URLSearchParams({ root: "/repo/wt/held" })
    render(<SourceControlPage />)
    expect(useGitStore.getState().rootDir).toBe("/repo/wt/held")
  })

  it("leaves the binding alone when no root is named", () => {
    act(() => useGitStore.getState().setRootDir("/repo"))
    render(<SourceControlPage />)
    expect(useGitStore.getState().rootDir).toBe("/repo")
  })

  /**
   * After the first bind the panel owns its own root. A user who then switches
   * roots by hand must not be dragged back by a URL that has not changed.
   */
  it("does not re-apply the same root after the user switches away", () => {
    params = new URLSearchParams({ root: "/repo/wt/held" })
    const { rerender } = render(<SourceControlPage />)
    expect(useGitStore.getState().rootDir).toBe("/repo/wt/held")

    act(() => useGitStore.getState().setRootDir("/repo"))
    rerender(<SourceControlPage />)
    expect(useGitStore.getState().rootDir).toBe("/repo")
  })

  /**
   * A surface that lists changes links to one of them. Selecting before
   * navigating was lost whenever the link also changed repository, because
   * binding a new root clears the selection; the root goes first, then the file.
   */
  it("binds ?root= first, then selects ?path= on the side ?staged= names", () => {
    act(() => useGitStore.getState().setRootDir("/elsewhere"))
    params = new URLSearchParams({ root: "/repo", path: "src/a.ts", staged: "1" })
    render(<SourceControlPage />)
    const state = useGitStore.getState()
    expect(state.rootDir).toBe("/repo")
    expect(state.selectedPath).toBe("src/a.ts")
    expect(state.selectedStaged).toBe(true)
  })

  it("opens the named file's drawer on a phone, and only when a file is named", () => {
    compactMock.mockReturnValue(true)
    params = new URLSearchParams({ root: "/repo", path: "a.ts" })
    const { unmount } = render(<SourceControlPage />)
    expect(screen.getByTestId("sc-mobile-stub")).toHaveAttribute("data-initial-diff-open", "true")
    unmount()

    params = new URLSearchParams({ root: "/repo" })
    render(<SourceControlPage />)
    expect(screen.getByTestId("sc-mobile-stub")).toHaveAttribute("data-initial-diff-open", "false")
  })

  it("re-selects when only the file changes, and accepts a file without a root", () => {
    params = new URLSearchParams({ root: "/repo", path: "a.ts" })
    const { rerender } = render(<SourceControlPage />)
    expect(useGitStore.getState().selectedPath).toBe("a.ts")

    params = new URLSearchParams({ root: "/repo", path: "b.ts", staged: "1" })
    rerender(<SourceControlPage />)
    expect(useGitStore.getState().selectedPath).toBe("b.ts")
    expect(useGitStore.getState().selectedStaged).toBe(true)

    params = new URLSearchParams({ path: "c.ts" })
    rerender(<SourceControlPage />)
    expect(useGitStore.getState().rootDir).toBe("/repo")
    expect(useGitStore.getState().selectedPath).toBe("c.ts")
  })
})
