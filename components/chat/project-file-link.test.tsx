import { fireEvent, render, screen } from "@testing-library/react"
import {
  __resetProjectEditorBridgeForTesting,
  registerProjectEditorOpener,
} from "@/lib/files/project-editor-bridge"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"
import { ProjectFileLink } from "./project-file-link"

beforeEach(() => {
  __resetProjectEditorBridgeForTesting()
  useFileViewerStore.setState({ open: false, path: null, line: null, column: null })
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

  expect(useFileViewerStore.getState()).toMatchObject({
    open: true,
    path: "/repo/src/a.ts",
    line: 7,
    column: null,
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
