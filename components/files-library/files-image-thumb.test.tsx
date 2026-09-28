/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/chat/media/resolve-media", () => ({
  acquireMedia: jest.fn(),
  releaseMedia: jest.fn(),
}))
import { acquireMedia, releaseMedia } from "@/lib/chat/media/resolve-media"
import { FilesImageThumb } from "./files-image-thumb"

const acquire = acquireMedia as jest.Mock
const release = releaseMedia as jest.Mock

beforeEach(() => {
  acquire.mockReset()
  release.mockReset()
})

it("shows the thumbnail and releases it on unmount", async () => {
  acquire.mockResolvedValue({ url: "blob:thumb" })
  const { unmount } = render(<FilesImageThumb hash="h1" alt="Shot" />)
  expect(screen.getByTestId("files-image-loading")).toBeInTheDocument()
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
