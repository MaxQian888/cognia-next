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

describe("command and goto modes", () => {
  const commands = [
    { id: "file.save", label: "File: Save", hint: "⌘S", run: jest.fn() },
    { id: "view.split", label: "View: Split Editor", hint: "⌘\\", run: jest.fn() },
  ]

  it("seeds '>' into the input and lists commands instead of files", async () => {
    renderOpen({
      seedQuery: { text: ">" },
      commands,
      deps: { walk: walk([entry("a.ts")]) },
    })
    expect(screen.getByPlaceholderText("Search files by name")).toHaveValue(">")
    expect(await screen.findByTestId("quick-open-cmd-file.save")).toBeInTheDocument()
    expect(screen.getByTestId("quick-open-cmd-view.split")).toBeInTheDocument()
    expect(screen.queryByTestId("quick-open-a.ts")).not.toBeInTheDocument()
    expect(screen.getByText("↑↓ navigate · ↵ run")).toBeInTheDocument()
  })

  it("a fresh seed object re-applies while open, even with the same text", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ProjectQuickOpen
        rootPath="/repo"
        open
        onOpenChange={jest.fn()}
        onOpenFile={jest.fn()}
        seedQuery={{ text: "" }}
        deps={{ walk: walk([entry("a.ts")]) }}
      />
    )
    await user.type(screen.getByPlaceholderText("Search files by name"), "a.t")
    rerender(
      <ProjectQuickOpen
        rootPath="/repo"
        open
        onOpenChange={jest.fn()}
        onOpenFile={jest.fn()}
        seedQuery={{ text: "" }}
        deps={{ walk: walk([entry("a.ts")]) }}
      />
    )
    expect(screen.getByPlaceholderText("Search files by name")).toHaveValue("")
  })

  it("filters commands by the text after '>' and runs the pick", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    renderOpen({
      onOpenChange,
      commands,
      deps: { walk: walk([]) },
    })
    await user.type(screen.getByPlaceholderText("Search files by name"), ">split")
    const row = await screen.findByTestId("quick-open-cmd-view.split")
    expect(screen.queryByTestId("quick-open-cmd-file.save")).not.toBeInTheDocument()
    await user.click(row)
    expect(commands[1].run).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("':12' offers a go-to-line row that jumps the active editor", async () => {
    const user = userEvent.setup()
    const onGoToLine = jest.fn()
    renderOpen({ onGoToLine, deps: { walk: walk([entry("a.ts")]) } })
    await user.type(screen.getByPlaceholderText("Search files by name"), ":12")
    const row = await screen.findByTestId("quick-open-goto-line")
    expect(row).toHaveTextContent("Go to line 12")
    await user.click(row)
    expect(onGoToLine).toHaveBeenCalledWith(null, 12, undefined)
  })

  it("':12:3' carries the column through to onGoToLine", async () => {
    const user = userEvent.setup()
    const onGoToLine = jest.fn()
    renderOpen({ onGoToLine, deps: { walk: walk([]) } })
    await user.type(screen.getByPlaceholderText("Search files by name"), ":12:3")
    const row = await screen.findByTestId("quick-open-goto-line")
    expect(row).toHaveTextContent("Go to line 12, column 3")
    await user.click(row)
    expect(onGoToLine).toHaveBeenCalledWith(null, 12, 3)
  })

  it("'file:7' keeps fuzzy file results and rides the goto path on pick", async () => {
    const user = userEvent.setup()
    const onGoToLine = jest.fn()
    const onOpenFile = jest.fn()
    renderOpen({
      onGoToLine,
      onOpenFile,
      deps: { walk: walk([entry("alpha.ts"), entry("beta.ts")]) },
    })
    await screen.findByTestId("quick-open-alpha.ts")
    await user.type(screen.getByPlaceholderText("Search files by name"), "alpha:7")
    const row = await screen.findByTestId("quick-open-alpha.ts")
    expect(screen.queryByTestId("quick-open-beta.ts")).not.toBeInTheDocument()
    await user.click(row)
    expect(onGoToLine).toHaveBeenCalledWith("alpha.ts", 7, undefined)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it("a non-numeric colon suffix stays part of the file query", async () => {
    const user = userEvent.setup()
    const onGoToLine = jest.fn()
    renderOpen({
      onGoToLine,
      deps: { walk: walk([entry("we:ird.ts"), entry("alpha.ts")]) },
    })
    await screen.findByTestId("quick-open-we:ird.ts")
    await user.type(screen.getByPlaceholderText("Search files by name"), "we:ir")
    expect(await screen.findByTestId("quick-open-we:ird.ts")).toBeInTheDocument()
    expect(screen.queryByTestId("quick-open-goto-line")).not.toBeInTheDocument()
  })
})

const TS_DOC = `export function greet(name: string) { return "hi " + name }
export const MAX = 3
export class Counter {
  private value = 0
  increment() { this.value += 1 }
}
interface Shape { area: number }
`

describe("@ symbol mode", () => {
  const activeDocument = {
    relPath: "src/app.ts",
    language: "typescript",
    content: TS_DOC,
  }

  it("lists the active document's symbols and jumps on pick", async () => {
    const onGoToLine = jest.fn()
    const user = userEvent.setup()
    renderOpen({ deps: { walk: walk([entry("a.ts")]) }, activeDocument, onGoToLine })
    const input = screen.getByPlaceholderText("Search files by name")
    await user.type(input, "@greet")
    const row = await screen.findByTestId("quick-open-symbol-greet")
    expect(row).toBeInTheDocument()
    // Non-matching symbols are filtered out by the fuzzy rank.
    expect(screen.queryByTestId("quick-open-symbol-Counter")).not.toBeInTheDocument()
    await user.click(row)
    expect(onGoToLine).toHaveBeenCalledWith(null, 1, 1)
  })

  it("flattens child symbols with their own line targets", async () => {
    const user = userEvent.setup()
    renderOpen({ deps: { walk: walk([]) }, activeDocument, onGoToLine: jest.fn() })
    await user.type(screen.getByPlaceholderText("Search files by name"), "@")
    // Class member appears alongside top-level symbols.
    expect(await screen.findByTestId("quick-open-symbol-increment")).toBeInTheDocument()
    expect(screen.getByTestId("quick-open-symbol-MAX")).toBeInTheDocument()
  })

  it("groups by symbol kind on '@:'", async () => {
    const user = userEvent.setup()
    renderOpen({ deps: { walk: walk([]) }, activeDocument })
    await user.type(screen.getByPlaceholderText("Search files by name"), "@:")
    expect(await screen.findByTestId("quick-open-symbol-greet")).toBeInTheDocument()
    // Kind headings render (en locale: plurals).
    expect(screen.getByText("functions")).toBeInTheDocument()
    expect(screen.getByText("classes")).toBeInTheDocument()
    expect(screen.getByText("variables")).toBeInTheDocument()
  })

  it("reports no active editor instead of an empty symbol list", async () => {
    const user = userEvent.setup()
    renderOpen({ deps: { walk: walk([]) }, activeDocument: null })
    await user.type(screen.getByPlaceholderText("Search files by name"), "@")
    expect(await screen.findByText("No active editor")).toBeInTheDocument()
  })

  it("does not treat a ':' inside '@' mode as a line suffix", async () => {
    const user = userEvent.setup()
    renderOpen({ deps: { walk: walk([]) }, activeDocument, onGoToLine: jest.fn() })
    // "@:g" is grouped mode with query "g" — must not become goto-line.
    await user.type(screen.getByPlaceholderText("Search files by name"), "@:g")
    expect(await screen.findByTestId("quick-open-symbol-greet")).toBeInTheDocument()
    expect(screen.queryByTestId("quick-open-goto-line")).not.toBeInTheDocument()
  })
})
