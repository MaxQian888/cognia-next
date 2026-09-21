/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectEditorBreadcrumbs } from "./project-editor-breadcrumbs"
import type { WorkspaceEntry } from "@/lib/files/types"

// Segment testid = `breadcrumb-segment-${dirRel || "root"}` where dirRel is the
// path *before* the segment — each dropdown lists its parent's children (the
// segment's siblings), the way VS Code breadcrumbs do. For relPath
// "src/deep/app.ts" that means:
//   root dropdown → ""   → testid breadcrumb-segment-root (first match)
//   "src" segment → ""   → testid breadcrumb-segment-root (second match)
//   "deep" segment → "src" → testid breadcrumb-segment-src
//   "app.ts" → the current page, no dropdown.
const REL_PATH = "src/deep/app.ts"

function entry(relPath: string, isDir = false): WorkspaceEntry {
  return { relPath, absolutePath: `/repo/${relPath}`, isDir, size: 1, mtimeMs: 0 }
}

function renderBar(overrides: Partial<Parameters<typeof ProjectEditorBreadcrumbs>[0]> = {}) {
  return render(
    <ProjectEditorBreadcrumbs
      rootPath="/repo"
      rootName="repo"
      relPath={REL_PATH}
      onOpenFile={jest.fn()}
      {...overrides}
    />
  )
}

describe("ProjectEditorBreadcrumbs", () => {
  it("renders the root plus one segment per path part; the file is a page", () => {
    renderBar()
    const rootTriggers = screen.getAllByTestId("breadcrumb-segment-root")
    expect(rootTriggers[0]).toHaveTextContent("repo")
    expect(rootTriggers[1]).toHaveTextContent("src")
    expect(screen.getByTestId("breadcrumb-segment-src")).toHaveTextContent("deep")
    // The filename is the non-interactive current page — no dropdown trigger.
    expect(screen.queryByTestId("breadcrumb-segment-src/deep")).not.toBeInTheDocument()
    expect(screen.getByText("app.ts")).toBeInTheDocument()
  })

  it("lists a segment's siblings when it opens", async () => {
    const listDir = jest.fn().mockResolvedValue([entry("src/app.ts"), entry("src/other", true)])
    const user = userEvent.setup()
    renderBar({ deps: { listDir } })
    // "deep" segment → parent dir "src" → the dropdown lists src's children.
    await user.click(screen.getByTestId("breadcrumb-segment-src"))
    expect(await screen.findByTestId("breadcrumb-file-src/app.ts")).toBeInTheDocument()
    expect(screen.getByTestId("breadcrumb-dir-src/other")).toBeInTheDocument()
    expect(listDir).toHaveBeenCalledWith("/repo", "src")
  })

  it("lists the root's children for both the root and the first segment", async () => {
    const listDir = jest.fn().mockResolvedValue([entry("a.ts")])
    const user = userEvent.setup()
    renderBar({ deps: { listDir } })
    await user.click(screen.getAllByTestId("breadcrumb-segment-root")[0])
    expect(await screen.findByTestId("breadcrumb-file-a.ts")).toBeInTheDocument()
    expect(listDir).toHaveBeenCalledWith("/repo", undefined)
    await user.keyboard("{Escape}")
    listDir.mockClear()
    await user.click(screen.getAllByTestId("breadcrumb-segment-root")[1])
    expect(await screen.findByTestId("breadcrumb-file-a.ts")).toBeInTheDocument()
    expect(listDir).toHaveBeenCalledWith("/repo", undefined)
  })

  it("opens a file straight into the editor when picked", async () => {
    const onOpenFile = jest.fn()
    const user = userEvent.setup()
    renderBar({ onOpenFile, deps: { listDir: jest.fn().mockResolvedValue([entry("a.ts")]) } })
    await user.click(screen.getAllByTestId("breadcrumb-segment-root")[0])
    await user.click(await screen.findByTestId("breadcrumb-file-a.ts"))
    expect(onOpenFile).toHaveBeenCalledWith("a.ts")
  })

  it("nests one submenu deeper for directories", async () => {
    const listDir = jest.fn((root: string, dir?: string) =>
      Promise.resolve(dir === "src" ? [entry("src/inner.ts")] : [entry("src", true)])
    )
    const user = userEvent.setup()
    renderBar({ deps: { listDir } })
    await user.click(screen.getAllByTestId("breadcrumb-segment-root")[0])
    await user.hover(await screen.findByTestId("breadcrumb-dir-src"))
    expect(await screen.findByTestId("breadcrumb-file-src/inner.ts")).toBeInTheDocument()
  })

  it("offers the reveal fallback only when a handler is supplied", async () => {
    const onRevealDir = jest.fn()
    const user = userEvent.setup()
    renderBar({
      onRevealDir,
      deps: { listDir: jest.fn().mockResolvedValue([entry("a.ts")]) },
    })
    await user.click(screen.getByTestId("breadcrumb-segment-src"))
    await user.click(await screen.findByText("Reveal in File Tree"))
    expect(onRevealDir).toHaveBeenCalledWith("src")
  })

  it("omits the reveal item without a handler", async () => {
    const user = userEvent.setup()
    renderBar({ deps: { listDir: jest.fn().mockResolvedValue([entry("a.ts")]) } })
    await user.click(screen.getByTestId("breadcrumb-segment-src"))
    await screen.findByTestId("breadcrumb-file-a.ts")
    expect(screen.queryByText("Reveal in File Tree")).not.toBeInTheDocument()
  })

  it("shows the empty state for a directory without children", async () => {
    const user = userEvent.setup()
    renderBar({ deps: { listDir: jest.fn().mockResolvedValue([]) } })
    await user.click(screen.getByTestId("breadcrumb-segment-src"))
    expect(await screen.findByText("Empty folder")).toBeInTheDocument()
  })

  it("shows the failure state when the listing rejects", async () => {
    const user = userEvent.setup()
    renderBar({ deps: { listDir: jest.fn().mockRejectedValue(new Error("denied")) } })
    await user.click(screen.getByTestId("breadcrumb-segment-src"))
    expect(await screen.findByText("Couldn't load this folder")).toBeInTheDocument()
  })
})
