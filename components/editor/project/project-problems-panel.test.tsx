/** @jest-environment jsdom */

/**
 * The Problems panel — workspace-wide marker list grouped by file.
 * Markers arrive through a fake MonacoLike; navigation goes through the
 * injected onNavigate (the workbench's gotoLine: open + reveal + jump).
 */

import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react"

import type { MonacoLike, RawMarker } from "@/hooks/use-monaco-markers"

import { ProjectProblemsPanel, useWorkbenchMarkers } from "./project-problems-panel"

function marker(over: Partial<RawMarker> = {}): RawMarker {
  return {
    severity: 8,
    message: "Type 'string' is not assignable to type 'number'.",
    startLineNumber: 3,
    startColumn: 5,
    endLineNumber: 3,
    endColumn: 10,
    ...over,
  }
}

function makeMonaco(markers: RawMarker[]) {
  const listeners = new Set<() => void>()
  const monaco: MonacoLike = {
    editor: {
      getModelMarkers: jest.fn(() => markers),
      onDidChangeMarkers: jest.fn((listener: () => void) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      }),
    },
  }
  return { monaco, listeners }
}

const at = (file: string, line: number, col: number, over: Partial<RawMarker> = {}) =>
  marker({
    startLineNumber: line,
    startColumn: col,
    resource: { toString: () => `file:///repo/${file}` },
    ...over,
  })

function renderPanel(
  markers: RawMarker[],
  over: Partial<Parameters<typeof ProjectProblemsPanel>[0]> = {}
) {
  const { monaco } = makeMonaco(markers)
  const onNavigate = jest.fn()
  const onClose = jest.fn()
  render(
    <ProjectProblemsPanel
      monaco={monaco}
      rootPath="/repo"
      onNavigate={onNavigate}
      onClose={onClose}
      {...over}
    />
  )
  return { onNavigate, onClose }
}

describe("ProjectProblemsPanel", () => {
  it("groups markers by file with sorted rows and severity icons", () => {
    renderPanel([
      at("src/b.ts", 9, 1),
      at("src/a.ts", 5, 1),
      at("src/a.ts", 2, 3, { severity: 4, message: "warn" }),
    ])
    const fileRows = screen
      .getAllByTestId(/^problems-file-/)
      .map((el) => el.getAttribute("data-testid"))
    expect(fileRows).toEqual(["problems-file-src/a.ts", "problems-file-src/b.ts"])

    const aRows = screen
      .getAllByTestId(/^problems-marker-src\/a\.ts-/)
      .map((el) => el.getAttribute("data-testid"))
    // Line order inside the file, not arrival order.
    expect(aRows).toEqual(["problems-marker-src/a.ts-2-3", "problems-marker-src/a.ts-5-1"])
  })

  it("shows the workspace-empty message when there are no markers", () => {
    renderPanel([])
    expect(
      screen.getByText("No problems have been detected in the workspace so far.")
    ).toBeInTheDocument()
  })

  it("navigates to the marker's file:line:col on click", () => {
    const { onNavigate } = renderPanel([at("src/a.ts", 7, 4)])
    fireEvent.click(screen.getByTestId("problems-marker-src/a.ts-7-4"))
    expect(onNavigate).toHaveBeenCalledWith("src/a.ts", 7, 4)
  })

  it("strips the workspace root prefix; keeps non-file URIs readable", () => {
    renderPanel([
      at("src/a.ts", 1, 1),
      marker({
        resource: { toString: () => "inmemory://model/1" },
        message: "plugin marker",
      }),
    ])
    expect(screen.getByTestId("problems-file-src/a.ts")).toBeInTheDocument()
    expect(screen.getByText("inmemory://model/1")).toBeInTheDocument()
  })

  it("collapses and re-expands a file group", () => {
    renderPanel([at("src/a.ts", 1, 1)])
    fireEvent.click(screen.getByTestId("problems-file-src/a.ts"))
    expect(screen.queryByTestId("problems-marker-src/a.ts-1-1")).toBeNull()
    fireEvent.click(screen.getByTestId("problems-file-src/a.ts"))
    expect(screen.getByTestId("problems-marker-src/a.ts-1-1")).toBeInTheDocument()
  })

  it("filters markers by message, path and source", () => {
    renderPanel([
      at("src/a.ts", 1, 1, { message: "alpha error" }),
      at("src/b.ts", 1, 1, { message: "beta warning", severity: 4 }),
    ])
    fireEvent.change(screen.getByTestId("problems-filter"), { target: { value: "alpha" } })
    expect(screen.queryByTestId("problems-file-src/b.ts")).toBeNull()
    expect(screen.getByTestId("problems-file-src/a.ts")).toBeInTheDocument()

    fireEvent.change(screen.getByTestId("problems-filter"), { target: { value: "zzz" } })
    expect(
      screen.getByText("No results found with the provided filter criteria.")
    ).toBeInTheDocument()
  })

  describe("filter grammar (text, globs, ! excludes, comma lists)", () => {
    // One marker per row, keyed `path:line` so assertions read as a list.
    const workspace = () => [
      at("src/a.ts", 1, 1, { message: "Alpha is not defined", source: "ts" }),
      at("src/a.ts", 2, 1, { message: "'x' is deprecated", severity: 4, source: "ts" }),
      at("src/deep/c.ts", 1, 1, { message: "Unused variable", severity: 4, source: "eslint" }),
      at("src/ab.ts", 1, 1, { message: "gamma" }),
      at("lib/b.tsx", 4, 1, { message: "Beta mismatch" }),
      at("docs/README.md", 1, 1, { message: "MD001 heading", source: "markdownlint" }),
      at("node_modules/pkg/index.d.ts", 7, 1, { message: "Alpha typing" }),
      at("src/a.test.ts", 3, 1, { message: "alpha in test" }),
    ]

    const visible = () =>
      screen
        .queryAllByTestId(/^problems-marker-/)
        .map((el) => el.getAttribute("data-testid")!.replace(/^problems-marker-/, ""))
        .map((id) => id.replace(/-(\d+)-\d+$/, ":$1"))
        .sort()

    const setFilter = (value: string) =>
      fireEvent.change(screen.getByTestId("problems-filter"), { target: { value } })

    it("matches a text term case-insensitively against message, source and path", () => {
      renderPanel(workspace())
      setFilter("ALPHA")
      expect(visible()).toEqual(["node_modules/pkg/index.d.ts:7", "src/a.test.ts:3", "src/a.ts:1"])
      setFilter("eslint")
      expect(visible()).toEqual(["src/deep/c.ts:1"])
      // No glob syntax → a plain substring of the path still counts.
      setFilter("README")
      expect(visible()).toEqual(["docs/README.md:1"])
    })

    it("matches a **/*.ts glob against the path, not the message", () => {
      renderPanel(workspace())
      setFilter("**/*.ts")
      expect(visible()).toEqual([
        "node_modules/pkg/index.d.ts:7",
        "src/a.test.ts:3",
        "src/a.ts:1",
        "src/a.ts:2",
        "src/ab.ts:1",
        "src/deep/c.ts:1",
      ])
      // `*.tsx` is a different extension; the message "Beta mismatch" is never globbed.
      setFilter("**/*.tsx")
      expect(visible()).toEqual(["lib/b.tsx:4"])
    })

    it("anchors a src/** glob at the workspace root", () => {
      renderPanel(workspace())
      setFilter("src/**")
      expect(visible()).toEqual([
        "src/a.test.ts:3",
        "src/a.ts:1",
        "src/a.ts:2",
        "src/ab.ts:1",
        "src/deep/c.ts:1",
      ])
    })

    it("treats a slash-free glob basename-style and supports ?", () => {
      renderPanel(workspace())
      setFilter("*.md")
      expect(visible()).toEqual(["docs/README.md:1"])
      setFilter("src/?.ts")
      expect(visible()).toEqual(["src/a.ts:1", "src/a.ts:2"])
      // Globs fold case like text does.
      setFilter("**/*.MD")
      expect(visible()).toEqual(["docs/README.md:1"])
    })

    it("excludes by glob with !**/node_modules/**", () => {
      renderPanel(workspace())
      setFilter("!**/node_modules/**")
      expect(visible()).not.toContain("node_modules/pkg/index.d.ts:7")
      expect(visible()).toHaveLength(7)
    })

    it("excludes by text across message, source and path", () => {
      renderPanel(workspace())
      setFilter("!deprecated")
      // Only the deprecated marker drops; its file keeps the other marker.
      expect(visible()).toContain("src/a.ts:1")
      expect(visible()).not.toContain("src/a.ts:2")
      expect(visible()).toHaveLength(7)
      setFilter("!markdownlint")
      expect(visible()).not.toContain("docs/README.md:1")
      setFilter("!node_modules")
      expect(visible()).not.toContain("node_modules/pkg/index.d.ts:7")
    })

    it("ORs include terms and lets any exclude term veto in a mixed comma list", () => {
      renderPanel(workspace())
      setFilter("alpha, **/*.md")
      expect(visible()).toEqual([
        "docs/README.md:1",
        "node_modules/pkg/index.d.ts:7",
        "src/a.test.ts:3",
        "src/a.ts:1",
      ])
      setFilter("src/**,!*.test.ts,!unused")
      expect(visible()).toEqual(["src/a.ts:1", "src/a.ts:2", "src/ab.ts:1"])
    })

    it("trims whitespace around terms and after the !", () => {
      renderPanel(workspace())
      setFilter("   src/**  ,   !  **/*.test.ts  ,  ! deprecated ")
      expect(visible()).toEqual(["src/a.ts:1", "src/ab.ts:1", "src/deep/c.ts:1"])
    })

    it("ignores empty terms, stray commas and a bare !", () => {
      renderPanel(workspace())
      setFilter(",, gamma ,,")
      expect(visible()).toEqual(["src/ab.ts:1"])
      setFilter(" , ! , ")
      expect(visible()).toHaveLength(8)
    })

    it("shows the no-match message when every marker is filtered out", () => {
      renderPanel(workspace())
      setFilter("!**")
      expect(visible()).toEqual([])
      expect(
        screen.getByText("No results found with the provided filter criteria.")
      ).toBeInTheDocument()
    })
  })

  it("renders header counts and closes via the X button", () => {
    const { onClose } = renderPanel([at("src/a.ts", 1, 1), at("src/a.ts", 2, 1, { severity: 4 })])
    expect(screen.getByText("Problems")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("problems-close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("keeps the header usable in a narrow editor column", () => {
    // As wide as the editor column — often under 400px in the chat dock. The
    // counts (the status bar repeats them) fold first; the filter shrinks
    // rather than pushing the close button off the row.
    renderPanel([at("src/a.ts", 1, 1)])
    const header = screen.getByTestId("problems-filter").parentElement!
    expect(header).toHaveClass("@container/problems", "min-w-0")
    expect(
      screen.getByText("Problems").parentElement!.querySelector(".text-red-500")!.parentElement
    ).toHaveClass("hidden", "@sm/problems:flex")
    expect(screen.getByTestId("problems-filter")).toHaveClass("min-w-16", "shrink")
    expect(screen.getByTestId("problems-close")).toHaveClass("shrink-0")
  })

  describe("context menus", () => {
    const markers = () => [at("src/a.ts", 3, 5), at("src/a.ts", 9, 1)]

    it("a file-group menu stages every marker of the file", async () => {
      const onAddMarkersToChat = jest.fn()
      renderPanel(markers(), { onAddMarkersToChat })
      fireEvent.contextMenu(screen.getByTestId("problems-file-src/a.ts"))
      const menu = await screen.findByTestId("problems-file-menu-src/a.ts")
      fireEvent.click(within(menu).getByText("Add to Chat"))
      expect(onAddMarkersToChat).toHaveBeenCalledTimes(1)
      const [relPath, staged] = onAddMarkersToChat.mock.calls[0]
      expect(relPath).toBe("src/a.ts")
      expect(staged.map((m: { startLineNumber: number }) => m.startLineNumber)).toEqual([3, 9])
    })

    it("a marker menu stages just that diagnostic", async () => {
      const onAddToChat = jest.fn()
      renderPanel(markers(), { onAddToChat })
      fireEvent.contextMenu(screen.getByTestId("problems-marker-src/a.ts-9-1"))
      const menu = await screen.findByTestId("problems-marker-menu-src/a.ts-9")
      fireEvent.click(within(menu).getByText("Add to Chat"))
      expect(onAddToChat).toHaveBeenCalledTimes(1)
      const [relPath, staged] = onAddToChat.mock.calls[0]
      expect(relPath).toBe("src/a.ts")
      expect(staged.startLineNumber).toBe(9)
    })

    it("a marker menu copies the diagnostic line to the clipboard", async () => {
      const writeText = jest.fn(async () => {})
      Object.assign(navigator, { clipboard: { writeText } })
      renderPanel(markers())
      fireEvent.contextMenu(screen.getByTestId("problems-marker-src/a.ts-3-5"))
      const menu = await screen.findByTestId("problems-marker-menu-src/a.ts-3")
      fireEvent.click(within(menu).getByText("Copy"))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("src/a.ts:3:5"))
    })

    it("hides the chat entries when no chat handler is wired", async () => {
      renderPanel(markers())
      fireEvent.contextMenu(screen.getByTestId("problems-file-src/a.ts"))
      const menu = await screen.findByTestId("problems-file-menu-src/a.ts")
      expect(within(menu).queryByText("Add to Chat")).toBeNull()
      // Copy stays — it needs no wiring.
      expect(within(menu).getByText("Copy Relative Path")).toBeInTheDocument()
    })
  })
})

describe("useWorkbenchMarkers", () => {
  it("summarizes severities across files", () => {
    const { monaco } = makeMonaco([
      at("src/a.ts", 1, 1),
      at("src/b.ts", 1, 1, { severity: 4 }),
      at("src/b.ts", 2, 1, { severity: 1 }),
    ])
    const { result } = renderHook(() => useWorkbenchMarkers(monaco, "/repo"))
    expect(result.current.summary).toEqual({ errors: 1, warnings: 1, infos: 1 })
    expect(result.current.files.map((f) => f.relPath)).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("re-reads markers when Monaco reports a change", async () => {
    const markers = [at("src/a.ts", 1, 1)]
    const { monaco, listeners } = makeMonaco(markers)
    const { result, rerender } = renderHook(() => useWorkbenchMarkers(monaco, "/repo"))
    expect(result.current.summary.errors).toBe(1)

    markers.push(at("src/a.ts", 9, 9, { severity: 4 }))
    act(() => {
      for (const l of listeners) l()
    })
    rerender()
    expect(result.current.summary).toEqual({ errors: 1, warnings: 1, infos: 0 })
  })
})
