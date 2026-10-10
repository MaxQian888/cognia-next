/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("@/components/document-templates/save-document-template-dialog", () => ({
  SaveDocumentTemplateDialog: ({ request }: { request: unknown }) =>
    request ? <div data-testid="save-request">{JSON.stringify(request)}</div> : null,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"
import type { FilesEntry } from "@/lib/files-library/types"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesSaveTemplateDialog } from "./files-save-template-dialog"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a",
    kind: "artifact",
    sourceId: "a",
    title: "Parser",
    sourceTitle: "Parser",
    subtype: "code",
    projectIds: [],
    sessionIds: ["s1"],
    originAlive: true,
    createdAt: 1,
    updatedAt: Date.UTC(2026, 8, 21),
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  useFilesLibraryStore.setState({ saveTemplateTarget: null })
  useArtifactStore.setState({
    canvasDocuments: {
      c1: { content: "# Notes", language: "markdown", type: "text" },
    } as never,
    artifacts: {},
  })
})

it("hands the item's current text to the save dialog", () => {
  const doc = entry({ key: "canvas:c1", kind: "canvas", sourceId: "c1", title: "Notes" })
  useFilesLibraryStore.setState({ saveTemplateTarget: doc.key })
  render(<FilesSaveTemplateDialog entries={[doc]} />)
  expect(JSON.parse(screen.getByTestId("save-request").textContent!)).toEqual({
    mode: "create",
    name: "Notes",
    draft: { content: "# Notes", language: "markdown", type: "text" },
  })
})

it("says so and closes when the item's text is gone", async () => {
  const gone = entry({ key: "canvas:gone", kind: "canvas", sourceId: "gone" })
  useFilesLibraryStore.setState({ saveTemplateTarget: gone.key })
  render(<FilesSaveTemplateDialog entries={[gone]} />)
  await waitFor(() => expect(useFilesLibraryStore.getState().saveTemplateTarget).toBeNull())
  expect(toast.error).toHaveBeenCalledWith(
    "This item’s content is no longer stored on this device."
  )
  expect(screen.queryByTestId("save-request")).toBeNull()
})

it("waits for the entries before deciding", () => {
  useFilesLibraryStore.setState({ saveTemplateTarget: "canvas:c1" })
  render(<FilesSaveTemplateDialog entries={[]} />)
  expect(toast.error).not.toHaveBeenCalled()
  expect(useFilesLibraryStore.getState().saveTemplateTarget).toBe("canvas:c1")
})
