/**
 * @jest-environment jsdom
 */

jest.mock("@/components/source-control/source-control-panel", () => ({
  SourceControlPanel: () => <div data-testid="sc-desktop-stub" />,
}))
jest.mock("@/components/mobile/source-control/source-control-mobile-body", () => ({
  SourceControlMobileBody: () => <div data-testid="sc-mobile-stub" />,
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
})
