/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

// jsdom 26 lacks `Blob.prototype.arrayBuffer` for synthesised `File`
// instances. The component awaits `file.arrayBuffer()`, so without the
// polyfill the upload promise never resolves.
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error ?? new Error("read failed"))
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))
jest.mock("@/lib/appearance/image-utils", () => ({
  readImageDimensions: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const imageUtils = require("@/lib/appearance/image-utils") as {
  readImageDimensions: jest.Mock
}

import { WallpaperUploader } from "./wallpaper-uploader"
import { MAX_WALLPAPER_BYTES } from "@/lib/appearance/wallpaper-storage"

beforeEach(() => {
  jest.clearAllMocks()
  imageUtils.readImageDimensions.mockResolvedValue({ width: 800, height: 600 })
})

describe("WallpaperUploader", () => {
  it("rejects unsupported mime types", async () => {
    const onUpload = jest.fn()
    render(<WallpaperUploader onUpload={onUpload} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["abc"], "doc.txt", { type: "text/plain" })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    expect(onUpload).not.toHaveBeenCalled()
    expect(screen.getByText("invalidType")).toBeInTheDocument()
  })

  it("rejects oversize files", async () => {
    const onUpload = jest.fn()
    render(<WallpaperUploader onUpload={onUpload} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const tooBig = new File([new Uint8Array([1])], "huge.png", { type: "image/png" })
    Object.defineProperty(tooBig, "size", { value: MAX_WALLPAPER_BYTES + 1 })
    await act(async () => {
      fireEvent.change(input, { target: { files: [tooBig] } })
    })
    expect(onUpload).not.toHaveBeenCalled()
    expect(screen.getByText("tooLarge")).toBeInTheDocument()
  })

  it("uploads a valid image and reports dimensions", async () => {
    const onUpload = jest.fn()
    render(<WallpaperUploader onUpload={onUpload} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], "ok.png", { type: "image/png" })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1))
    expect(onUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        mime: "image/png",
        fileName: "ok.png",
        width: 800,
        height: 600,
      })
    )
  })

  it("surfaces a load error when the image cannot be decoded", async () => {
    imageUtils.readImageDimensions.mockRejectedValueOnce(new Error("could not decode image"))
    const onUpload = jest.fn()
    render(<WallpaperUploader onUpload={onUpload} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1])], "broken.png", { type: "image/png" })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByText(/could not decode image/i)).toBeInTheDocument())
    expect(onUpload).not.toHaveBeenCalled()
  })

  it("triggers the file picker via the browse button", async () => {
    render(<WallpaperUploader onUpload={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = jest.spyOn(input, "click").mockImplementation(() => {})
    fireEvent.click(screen.getByText("browse"))
    expect(clickSpy).toHaveBeenCalled()
  })

  // Drag-and-drop moved to the gallery grid (see `wallpaper-tab.test.tsx`);
  // both paths share `intakeWallpaperFile`, so the validation above covers it.
  it("disables the browse button while busy elsewhere", () => {
    render(<WallpaperUploader onUpload={() => {}} disabled />)
    expect(screen.getByText("browse").closest("button")).toBeDisabled()
  })
})
