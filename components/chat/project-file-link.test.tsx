import { fireEvent, render, screen } from "@testing-library/react"
import {
  __resetProjectEditorBridgeForTesting,
  registerProjectEditorOpener,
} from "@/lib/files/project-editor-bridge"
import { useFileViewerStore } from "@/stores/file-viewer/file-viewer-store"
import { useProjectStore } from "@/stores/project/project-store"
import { ProjectFileLink } from "./project-file-link"

beforeEach(() => {
  __resetProjectEditorBridgeForTesting()
  useFileViewerStore.setState({ open: false, request: null, failure: null })
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "repo", roots: [{ id: "r1", path: "/repo", primary: true }] },
    ] as never,
  })
})

it("opens a conversation file link in the active project editor", () => {
  const open = jest.fn()
  registerProjectEditorOpener({ root: "/repo", open })
  render(
    <ProjectFileLink target={{ absolutePath: "/repo/src/a.ts", line: 7, column: 2 }}>
      src/a.ts
    </ProjectFileLink>
  )

  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }))

  expect(open).toHaveBeenCalledWith("src/a.ts", 7, 2)
  expect(useFileViewerStore.getState().open).toBe(false)
})

it("falls back to the read-only viewer when no project editor is mounted", () => {
  render(
    <ProjectFileLink target={{ absolutePath: "/repo/src/a.ts", line: 7 }}>src/a.ts</ProjectFileLink>
  )

  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }))

  // The absolute path is resolved against the open workspace before anything is
  // read, so the viewer receives a confined `{ root, relPath }` pair.
  expect(useFileViewerStore.getState()).toMatchObject({
    open: true,
    failure: null,
    request: { root: "/repo", relPath: "src/a.ts", line: 7, column: null },
  })
})

it("refuses a path outside every open workspace, visibly", () => {
  render(
    <ProjectFileLink target={{ absolutePath: "/usr/lib/node_modules/x/index.js" }}>
      index.js
    </ProjectFileLink>
  )

  fireEvent.click(screen.getByRole("button", { name: "index.js" }))

  // Opening on the refusal rather than doing nothing: a click that silently
  // fails is indistinguishable from a broken link.
  expect(useFileViewerStore.getState()).toMatchObject({
    open: true,
    request: null,
    failure: { code: "outside-workspace", displayName: "index.js" },
  })
})

it("lets an owning workspace perform a deferred editor-tab handoff", () => {
  const onOpenFile = jest.fn()
  render(
    <ProjectFileLink target={{ absolutePath: "/repo/src/a.ts" }} onOpenFile={onOpenFile}>
      src/a.ts
    </ProjectFileLink>
  )

  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }))

  expect(onOpenFile).toHaveBeenCalledWith({ absolutePath: "/repo/src/a.ts" })
  expect(useFileViewerStore.getState().open).toBe(false)
})
