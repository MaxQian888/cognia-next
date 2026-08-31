/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

let projects: Array<{
  id: string
  roots: Array<{ id: string; path: string; isPrimary?: boolean }>
}> = []
let gitState: Record<string, unknown> = {}
let breakpoint: "mobile" | "tablet" | "desktop" = "desktop"
const gitDiffStat = jest.fn()
const undoWorkspaceChanges = jest.fn()
const discardWorkspaceFile = jest.fn()
const toastError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: (...args: unknown[]) => toastError(...args) },
}))
jest.mock("@/hooks/ui", () => ({ useBreakpoint: () => breakpoint }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: { projects: typeof projects }) => unknown) =>
    selector({ projects }),
}))
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState),
}))
jest.mock("@/lib/git/commands", () => ({
  gitDiffStat: (...args: unknown[]) => gitDiffStat(...args),
}))
jest.mock("@/lib/git/workspace-changes", () => {
  const actual = jest.requireActual<typeof import("@/lib/git/workspace-changes")>(
    "@/lib/git/workspace-changes"
  )
  return {
    ...actual,
    undoWorkspaceChanges: (...args: unknown[]) => undoWorkspaceChanges(...args),
    discardWorkspaceFile: (...args: unknown[]) => discardWorkspaceFile(...args),
  }
})

import { WorkspaceChangesCard } from "./workspace-changes-card"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

const session = { id: "session-1", projectId: "project-1" } as never
const status = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  merge: [],
  staged: [{ path: "src/a.ts", origPath: null, status: "modified", staged: true, group: "staged" }],
  changes: [
    { path: "src/a.ts", origPath: null, status: "modified", staged: false, group: "changes" },
    { path: "src/b.ts", origPath: null, status: "untracked", staged: false, group: "changes" },
  ],
  isRebasing: false,
  isMerging: false,
}

beforeEach(() => {
  breakpoint = "desktop"
  projects = [{ id: "project-1", roots: [{ id: "root-1", path: "/repo", isPrimary: true }] }]
  gitState = { rootDir: "/repo", repoState: { isRepo: true }, status }
  gitDiffStat.mockReset().mockResolvedValue([
    { path: "src/a.ts", insertions: 3, deletions: 1 },
    { path: "src/b.ts", insertions: 2, deletions: 0 },
  ])
  undoWorkspaceChanges.mockReset().mockResolvedValue(undefined)
  discardWorkspaceFile.mockReset().mockResolvedValue(undefined)
  toastError.mockReset()
  act(() => useArtifactDockLayoutStore.getState().resetLayout())
})

describe("WorkspaceChangesCard", () => {
  it("shows the per-file discard button on touch instead of hiding it invisibly", async () => {
    // `opacity-0` hides but does not disable: without a coarse-pointer reveal
    // this destructive control was invisible AND tappable on a phone.
    render(<WorkspaceChangesCard session={session} />)
    fireEvent.click(screen.getByTestId("workspace-changes-toggle"))
    const discard = await screen.findByTestId("workspace-change-discard-src/a.ts")
    expect(discard.className).toContain("pointer-coarse:opacity-100")
  })

  it("discards a single file only after confirmation", async () => {
    render(<WorkspaceChangesCard session={session} />)
    fireEvent.click(screen.getByTestId("workspace-changes-toggle"))

    fireEvent.click(await screen.findByTestId("workspace-change-discard-src/a.ts"))
    expect(discardWorkspaceFile).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByTestId("workspace-change-discard-confirm"))
    await waitFor(() =>
      expect(discardWorkspaceFile).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ path: "src/a.ts" })
      )
    )
  })

  it("renders and loads stats in the mobile Sheet layout", async () => {
    breakpoint = "mobile"
    render(<WorkspaceChangesCard session={session} />)

    expect(screen.getByTestId("workspace-changes-card")).toHaveAttribute(
      "data-breakpoint",
      "mobile"
    )
    await waitFor(() => expect(gitDiffStat).toHaveBeenCalledWith("/repo"))
  })

  it("does not render outside the active Git root or with no changes", () => {
    gitState = { ...gitState, rootDir: "/other" }
    const { rerender } = render(<WorkspaceChangesCard session={session} />)
    expect(screen.queryByTestId("workspace-changes-card")).not.toBeInTheDocument()

    gitState = {
      ...gitState,
      rootDir: "/repo",
      status: { ...status, staged: [], changes: [], merge: [] },
    }
    rerender(<WorkspaceChangesCard session={session} />)
    expect(screen.queryByTestId("workspace-changes-card")).not.toBeInTheDocument()
  })

  it("deduplicates files and lazily shows real aggregate line totals", async () => {
    render(<WorkspaceChangesCard session={session} />)

    expect(screen.getByTestId("workspace-changes-count")).toHaveTextContent("2")
    expect(gitDiffStat).toHaveBeenCalledWith("/repo")
    await waitFor(() =>
      expect(screen.getByTestId("workspace-changes-total")).toHaveTextContent("+5")
    )
    expect(screen.getByTestId("workspace-changes-total")).toHaveTextContent("−1")
  })

  it("keeps the reliable file count when diff statistics fail", async () => {
    gitDiffStat.mockRejectedValue(new Error("stat failed"))
    render(<WorkspaceChangesCard session={session} />)

    await waitFor(() => expect(gitDiffStat).toHaveBeenCalledWith("/repo"))
    expect(screen.getByTestId("workspace-changes-count")).toHaveTextContent("2")
    expect(screen.queryByTestId("workspace-changes-total")).not.toBeInTheDocument()
  })

  it("expands all files and routes file/review actions through the dock reveal queue", async () => {
    render(<WorkspaceChangesCard session={session} />)
    fireEvent.click(screen.getByTestId("workspace-changes-toggle"))

    const file = await screen.findByTestId("workspace-change-src/a.ts")
    fireEvent.click(file)
    expect(useArtifactDockLayoutStore.getState().workspaceRevealRequest).toMatchObject({
      kind: "file",
      sessionId: "session-1",
      rootPath: "/repo",
      relPath: "src/a.ts",
    })
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true)

    fireEvent.click(screen.getByTestId("workspace-changes-review"))
    expect(useArtifactDockLayoutStore.getState().workspaceRevealRequest).toMatchObject({
      kind: "review",
      sessionId: "session-1",
      rootPath: "/repo",
    })
  })

  it("requires confirmation before undoing the whole repository snapshot", async () => {
    render(<WorkspaceChangesCard session={session} />)
    fireEvent.click(screen.getByTestId("workspace-changes-toggle"))
    fireEvent.click(screen.getByTestId("workspace-changes-undo"))
    expect(undoWorkspaceChanges).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByTestId("workspace-changes-undo-confirm"))
    await waitFor(() => expect(undoWorkspaceChanges).toHaveBeenCalledWith("/repo", status))
  })

  it("keeps the card visible and reports an undo failure", async () => {
    undoWorkspaceChanges.mockRejectedValue(new Error("cannot discard"))
    render(<WorkspaceChangesCard session={session} />)
    fireEvent.click(screen.getByTestId("workspace-changes-toggle"))
    fireEvent.click(screen.getByTestId("workspace-changes-undo"))
    fireEvent.click(await screen.findByTestId("workspace-changes-undo-confirm"))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByTestId("workspace-changes-card")).toBeInTheDocument()
  })
})
