/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({ artifact }: { artifact: { id: string } }) => (
    <div data-testid={`artifact-preview-${artifact.id}`} />
  ),
}))
jest.mock("@/components/chat/message-parts/file-part-preview", () => ({
  FilePartPreview: ({ url, filename }: { url: string; filename: string }) => (
    <div data-testid="file-part-preview" data-url={url} data-filename={filename} />
  ),
}))
jest.mock("./files-image-thumb", () => ({
  FilesImageThumb: ({ hash, full }: { hash: string; full?: boolean }) => (
    <div data-testid={`thumb-${hash}-${full ? "full" : "thumb"}`} />
  ),
}))
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: () => [{ id: "s1", title: "Design chat" }],
}))
jest.mock("@/lib/files-library/download", () => ({ downloadPayloadFor: jest.fn() }))
jest.mock("@/lib/files-library/open", () => ({ goToSession: jest.fn(async () => {}) }))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { downloadPayloadFor } from "@/lib/files-library/download"
import { goToSession } from "@/lib/files-library/open"
import type { FilesEntry } from "@/lib/files-library/types"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { FilesPreviewPane } from "./files-preview-pane"

const payload = downloadPayloadFor as jest.Mock

function entry(overrides: Partial<FilesEntry>): FilesEntry {
  return {
    key: "upload:u1",
    kind: "upload",
    sourceId: "u1",
    title: "notes.md",
    mediaType: "text/markdown",
    byteSize: 12,
    projectIds: [],
    sessionIds: ["s1"],
    originAlive: true,
    createdAt: 1,
    updatedAt: 2,
    ownedByFiles: true,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

function actions() {
  return {
    open: jest.fn(async () => {}),
    useInChat: jest.fn(async () => {}),
    download: jest.fn(async () => {}),
    toggleFavorite: jest.fn(async () => {}),
  } as unknown as jest.Mocked<FilesActions>
}

beforeAll(() => {
  URL.createObjectURL = jest.fn(() => "blob:preview")
  URL.revokeObjectURL = jest.fn()
})
beforeEach(() => payload.mockReset())

it("previews an upload through the chat file preview and lists details and conversations", async () => {
  payload.mockResolvedValue({
    blob: new Blob(["# n"], { type: "text/markdown" }),
    filename: "notes.md",
  })
  const a = actions()
  const e = entry({})
  const onClose = jest.fn()
  const user = userEvent.setup()
  render(<FilesPreviewPane entry={e} actions={a} onClose={onClose} />)
  expect(screen.getByTestId("files-preview-loading")).toBeInTheDocument()
  expect(await screen.findByTestId("file-part-preview")).toHaveAttribute(
    "data-filename",
    "notes.md"
  )
  expect(screen.getByText("text/markdown")).toBeInTheDocument()
  expect(screen.getByText("12 B")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Design chat" }))
  expect(goToSession).toHaveBeenCalledWith("s1", expect.anything())
  await user.click(screen.getByRole("button", { name: "Open" }))
  await user.click(screen.getByRole("button", { name: "Use in chat" }))
  await user.click(screen.getByRole("button", { name: "Download" }))
  await user.click(screen.getByRole("button", { name: "Add to favorites" }))
  expect(a.open).toHaveBeenCalledWith(e)
  expect(a.useInChat).toHaveBeenCalledWith(e)
  expect(a.download).toHaveBeenCalledWith(e)
  expect(a.toggleFavorite).toHaveBeenCalledWith(e)
  await user.click(screen.getByRole("button", { name: "Close preview" }))
  expect(onClose).toHaveBeenCalled()
})

it("says so when the bytes are gone, and when the conversation was deleted", async () => {
  payload.mockResolvedValue(null)
  render(
    <FilesPreviewPane
      entry={entry({ originAlive: false, favoritedAt: 3 })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(await screen.findByTestId("files-preview-unavailable")).toBeInTheDocument()
  expect(screen.getByTestId("files-preview-source-deleted")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Remove from favorites" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
})

it("leaves the loading state when reading preview bytes fails", async () => {
  payload.mockRejectedValueOnce(new Error("storage read failed"))
  render(<FilesPreviewPane entry={entry({})} actions={actions()} onClose={jest.fn()} />)
  expect(await screen.findByTestId("files-preview-unavailable")).toBeInTheDocument()
  expect(screen.queryByTestId("files-preview-loading")).not.toBeInTheDocument()
})

it("renders images full size and artifacts through the artifact preview", () => {
  useArtifactStore.setState({
    artifacts: {
      a1: {
        id: "a1",
        sessionId: "s1",
        messageId: "m",
        type: "code",
        title: "A",
        content: "x",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never,
  })
  const { rerender } = render(
    <FilesPreviewPane
      entry={entry({ key: "image:h", kind: "image", sourceId: "h", title: "" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("thumb-h-full")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Untitled image" })).toBeInTheDocument()
  rerender(
    <FilesPreviewPane
      entry={entry({ key: "artifact:a1", kind: "artifact", sourceId: "a1", title: "A" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("artifact-preview-a1")).toBeInTheDocument()
  rerender(
    <FilesPreviewPane
      entry={entry({ key: "artifact:gone", kind: "artifact", sourceId: "gone", title: "G" })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByTestId("files-preview-unavailable")).toBeInTheDocument()
})

it("previews a canvas document from its content", async () => {
  useArtifactStore.setState({
    canvasDocuments: {
      c1: {
        id: "c1",
        sessionId: "standalone",
        title: "Doc",
        content: "# d",
        language: "markdown",
        type: "text",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never,
  })
  payload.mockResolvedValue({ blob: new Blob(["# d"]), filename: "Doc.md" })
  render(
    <FilesPreviewPane
      entry={entry({
        key: "canvas:c1",
        kind: "canvas",
        sourceId: "c1",
        title: "Doc",
        mediaType: undefined,
      })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  await waitFor(() =>
    expect(screen.getByTestId("file-part-preview")).toHaveAttribute("data-filename", "Doc.md")
  )
})

it("labels a generated video and lists what its job recorded", async () => {
  payload.mockResolvedValue({
    blob: new Blob(["v"], { type: "video/mp4" }),
    filename: "A paper boat.mp4",
  })
  render(
    <FilesPreviewPane
      entry={entry({
        key: "session-upload:v1",
        kind: "session-upload",
        sourceId: "v1",
        title: "A paper boat.mp4",
        mediaType: "video/mp4",
        ownedByFiles: false,
        generated: {
          jobId: "vjob_1",
          prompt: "A paper boat on a rainy street",
          providerId: "doubao",
          modelId: "seedance-1-5-pro",
          durationSec: 5.04,
          width: 1280,
          height: 720,
        },
      })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(await screen.findByTestId("file-part-preview")).toBeInTheDocument()
  expect(screen.getByText("Video")).toBeInTheDocument()
  expect(screen.getByTestId("files-preview-prompt")).toHaveTextContent(
    "A paper boat on a rainy street"
  )
  expect(screen.getByText(/· seedance-1-5-pro$/)).toBeInTheDocument()
  expect(screen.getByText("5 s")).toBeInTheDocument()
  expect(screen.getByText("1280 × 720")).toBeInTheDocument()
})

it("lists no generation details for an ordinary upload", async () => {
  payload.mockResolvedValue({ blob: new Blob(["x"]), filename: "notes.md" })
  render(<FilesPreviewPane entry={entry({})} actions={actions()} onClose={jest.fn()} />)
  expect(await screen.findByTestId("file-part-preview")).toBeInTheDocument()
  expect(screen.queryByTestId("files-preview-prompt")).not.toBeInTheDocument()
  expect(screen.getByText("File")).toBeInTheDocument()
})

it("allows long metadata to wrap within a narrow details column", () => {
  const language = "language".repeat(50)
  render(
    <FilesPreviewPane
      entry={entry({ kind: "artifact", language })}
      actions={actions()}
      onClose={jest.fn()}
    />
  )
  expect(screen.getByText(language).closest("dl")).toHaveClass("grid-cols-[auto_minmax(0,1fr)]")
  expect(screen.getByText(language)).toHaveClass("[overflow-wrap:anywhere]")
})
