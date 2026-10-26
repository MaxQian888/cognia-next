/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/chat/media/resolve-media", () => ({
  acquireMedia: jest.fn(),
  releaseMedia: jest.fn(),
}))
import { acquireMedia, releaseMedia } from "@/lib/chat/media/resolve-media"
import { FilesBackendProvider, type FilesBackend } from "@/hooks/files-library/files-backend"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesImageThumb } from "./files-image-thumb"

const acquire = acquireMedia as jest.Mock
const release = releaseMedia as jest.Mock

beforeEach(() => {
  acquire.mockReset()
  release.mockReset()
})

it("shows the thumbnail and releases it on unmount", async () => {
  acquire.mockResolvedValue({ url: "blob:thumb" })
  const { unmount } = render(<FilesImageThumb hash="h1" alt="Shot" className="size-12 rounded" />)
  const pending = screen.getByTestId("files-image-loading")
  // The shared Skeleton: its marker keeps the pulse under reduced motion.
  expect(pending).toHaveAttribute("data-slot", "skeleton")
  expect(pending).toHaveAttribute("aria-hidden", "true")
  expect(pending).toHaveClass("size-12", "rounded", "bg-muted")
  const img = await screen.findByTestId("files-image")
  expect(img).toHaveAttribute("src", "blob:thumb")
  expect(img).toHaveAttribute("alt", "Shot")
  expect(acquire).toHaveBeenCalledWith("cognia-media:h1", { thumbnail: true })
  unmount()
  expect(release).toHaveBeenCalledWith("cognia-media:h1", { thumbnail: true })
})

it("asks for the canonical frame in full mode and shows a placeholder when missing", async () => {
  acquire.mockResolvedValue(null)
  render(<FilesImageThumb hash="h2" alt="Gone" full />)
  expect(await screen.findByTestId("files-image-missing")).toBeInTheDocument()
  expect(acquire).toHaveBeenCalledWith("cognia-media:h2", { thumbnail: false })
})

it("releases a URL that resolves after unmount", async () => {
  let resolve!: (value: unknown) => void
  acquire.mockReturnValue(new Promise((r) => (resolve = r)))
  const { unmount } = render(<FilesImageThumb hash="h3" alt="Late" />)
  unmount()
  resolve({ url: "blob:late" })
  await waitFor(() => expect(release).toHaveBeenCalledWith("cognia-media:h3", { thumbnail: true }))
})

it("shows the placeholder when resolving throws", async () => {
  acquire.mockRejectedValue(new Error("db closed"))
  render(<FilesImageThumb hash="h4" alt="Err" />)
  expect(await screen.findByTestId("files-image-missing")).toBeInTheDocument()
})

it("fetches bytes the media store lacks from where the page's backend says they live", async () => {
  acquire.mockResolvedValue({ url: "blob:host" })
  const loader = jest.fn()
  const backend = {
    source: { entries: [], imagesTruncated: false, loadMoreImages: () => {}, folders: [] },
    ops: {},
    mediaLoaderFor: () => loader,
  } as unknown as FilesBackend
  const entry = {
    key: "image:h4",
    mediaHash: undefined,
    sessionIds: ["s1"],
  } as unknown as FilesEntry
  render(
    <FilesBackendProvider backend={backend}>
      <FilesImageThumb hash="h4" alt="Host" entry={entry} />
    </FilesBackendProvider>
  )
  expect(await screen.findByTestId("files-image")).toHaveAttribute("src", "blob:host")
  expect(acquire).toHaveBeenCalledWith("cognia-media:h4", { thumbnail: true, loadMissing: loader })
})
