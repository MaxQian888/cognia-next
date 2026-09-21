/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectQuickOpen } from "./project-quick-open"
import type { WorkspaceEntry } from "@/lib/files/types"

function entry(relPath: string, isDir = false): WorkspaceEntry {
  return { relPath, absolutePath: `/repo/${relPath}`, isDir, size: 1, mtimeMs: 0 }
}

function walk(entries: WorkspaceEntry[], truncated = false) {
  return jest.fn().mockResolvedValue({ entries, truncated })
}

function renderOpen(overrides: Partial<Parameters<typeof ProjectQuickOpen>[0]> = {}) {
  return render(
    <ProjectQuickOpen
      rootPath="/repo"
      open
      onOpenChange={jest.fn()}
      onOpenFile={jest.fn()}
      {...overrides}
    />
  )
}

describe("ProjectQuickOpen", () => {
  it("walks the workspace on open and lists only files", async () => {
    const walkFn = walk([entry("a.ts"), entry("src", true), entry("src/b.ts")])
    renderOpen({ deps: { walk: walkFn } })
    expect(walkFn).toHaveBeenCalledWith("/repo", { maxEntries: 20_000 })
    expect(await screen.findByTestId("quick-open-a.ts")).toBeInTheDocument()
    expect(screen.getByTestId("quick-open-src/b.ts")).toBeInTheDocument()
    expect(screen.queryByTestId("quick-open-src")).not.toBeInTheDocument()
  })

  it("does not walk while closed", () => {
    const walkFn = walk([entry("a.ts")])
    render(
      <ProjectQuickOpen
        rootPath="/repo"
        open={false}
        onOpenChange={jest.fn()}
        onOpenFile={jest.fn()}
        deps={{ walk: walkFn }}
      />
    )
    expect(walkFn).not.toHaveBeenCalled()
  })

  it("shows the indexed count once the walk resolves", async () => {
    renderOpen({ deps: { walk: walk([entry("a.ts"), entry("b.ts")]) } })
    expect(await screen.findByText("2 files indexed")).toBeInTheDocument()
  })

  it("marks a truncated index", async () => {
    renderOpen({ deps: { walk: walk([entry("a.ts")], true) } })
    expect(await screen.findByText("1 files indexed (truncated)")).toBeInTheDocument()
  })

  it("filters and ranks by the fuzzy query", async () => {
    const user = userEvent.setup()
    renderOpen({
      deps: {
        walk: walk([entry("src/board/kanban.ts"), entry("readme.md"), entry("src/card.ts")]),
      },
    })
    await screen.findByTestId("quick-open-src/board/kanban.ts")
    await user.type(screen.getByPlaceholderText("Search files by name"), "kanban")
    await waitFor(() => {
      expect(screen.getByTestId("quick-open-src/board/kanban.ts")).toBeInTheDocument()
      expect(screen.queryByTestId("quick-open-readme.md")).not.toBeInTheDocument()
      expect(screen.queryByTestId("quick-open-src/card.ts")).not.toBeInTheDocument()
    })
  })

  it("offers open editors first when the query is empty", async () => {
    renderOpen({
      openPaths: ["open/one.ts", "open/two.ts"],
      deps: { walk: walk([entry("open/one.ts"), entry("other.ts")]) },
    })
    // Wait for the async walk before counting — the all-files group mounts then.
    await screen.findByTestId("quick-open-other.ts")
    // Same path appears in both groups — the row keys are value-prefixed.
    expect(screen.getAllByTestId("quick-open-open/one.ts")).toHaveLength(2)
    expect(screen.getByText("open editors")).toBeInTheDocument()
    expect(screen.getByText("all files")).toBeInTheDocument()
  })

  it("picks a file: closes the palette and opens it pinned", async () => {
    const onOpenFile = jest.fn()
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    renderOpen({ onOpenFile, onOpenChange, deps: { walk: walk([entry("a.ts")]) } })
    await user.click(await screen.findByTestId("quick-open-a.ts"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenFile).toHaveBeenCalledWith("a.ts")
  })

  it("surfaces the empty state when the index has no match", async () => {
    const user = userEvent.setup()
    renderOpen({ deps: { walk: walk([entry("a.ts")]) } })
    await screen.findByTestId("quick-open-a.ts")
    await user.type(screen.getByPlaceholderText("Search files by name"), "zzzzzz")
    expect(await screen.findByText("No matching files")).toBeInTheDocument()
  })

  it("shows an empty palette (not a crash) when the walk fails", async () => {
    renderOpen({ deps: { walk: jest.fn().mockRejectedValue(new Error("denied")) } })
    await waitFor(() => expect(screen.getByText("0 files indexed")).toBeInTheDocument())
  })

  it("drops a stale walk that resolves after a newer open", async () => {
    // First walk stays pending forever; the re-open supersedes it.
    let resolveSecond: ((v: { entries: WorkspaceEntry[]; truncated: boolean }) => void) | null =
      null
    const walkFn = jest
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r
          })
      )
    const { rerender } = render(
      <ProjectQuickOpen
        rootPath="/repo"
        open
        onOpenChange={jest.fn()}
        onOpenFile={jest.fn()}
        deps={{ walk: walkFn }}
      />
    )
    rerender(
      <ProjectQuickOpen
        rootPath="/repo"
        open={false}
        onOpenChange={jest.fn()}
        onOpenFile={jest.fn()}
        deps={{ walk: walkFn }}
      />
    )
    rerender(
      <ProjectQuickOpen
        rootPath="/repo"
        open
        onOpenChange={jest.fn()}
        onOpenFile={jest.fn()}
        deps={{ walk: walkFn }}
      />
    )
    resolveSecond!({ entries: [entry("new.ts")], truncated: false })
    expect(await screen.findByTestId("quick-open-new.ts")).toBeInTheDocument()
    expect(walkFn).toHaveBeenCalledTimes(2)
  })
})
