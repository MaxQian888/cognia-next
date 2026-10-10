import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/share/blobs", () => ({
  ...jest.requireActual("@/lib/share/blobs"),
  downloadShareBlob: jest.fn(),
}))
jest.mock("@/lib/files/download", () => ({ downloadBlob: jest.fn() }))

import { downloadBlob } from "@/lib/files/download"
import {
  ShareFileIntegrityError,
  ShareTicketExpiredError,
  downloadShareBlob,
} from "@/lib/share/blobs"
import type { ShareFilesAccess } from "@/lib/share/load"
import type { ShareFileEntry } from "@/lib/share/types"

import {
  SHARE_AUTO_PREVIEW_MAX_BYTES,
  SHARE_MEDIA_PREVIEW_MAX_BYTES,
  SHARE_TEXT_PREVIEW_MAX_BYTES,
  ShareFilesSection,
  shareFileVisual,
  sharePreviewKind,
} from "./share-files-section"

const download = downloadShareBlob as jest.Mock
const save = downloadBlob as jest.Mock

function entry(name: string, mime: string, size = 12): ShareFileEntry {
  return {
    blobId: `${name.padEnd(22, "x")}`.slice(0, 22),
    path: `/workspace/${name}`,
    name,
    mime,
    size,
    sha256: "0".repeat(64),
    chunkSize: 4194304,
    chunkCount: 1,
    ivPrefix: "AAAAAAAAAAA=",
  }
}

const ACCESS: ShareFilesAccess = {
  baseUrl: "https://share.example",
  code: "Code12345678",
  readTicket: "1.sig",
  readTicketExpiresAt: Date.UTC(2030, 0, 1),
  material: new Uint8Array(32),
}

beforeAll(() => {
  globalThis.URL.createObjectURL = jest.fn(() => "blob:preview")
  globalThis.URL.revokeObjectURL = jest.fn()
})

beforeEach(() => {
  download.mockReset()
  save.mockReset()
})

describe("shareFileVisual", () => {
  it("draws a file by what it is", () => {
    expect(shareFileVisual({ mime: "image/png", name: "a.png" })).toBe("image")
    expect(shareFileVisual({ mime: "application/pdf", name: "a.pdf" })).toBe("pdf")
    expect(shareFileVisual({ mime: "text/plain", name: "build.py" })).toBe("code")
    expect(shareFileVisual({ mime: "text/markdown", name: "notes.md" })).toBe("text")
    expect(shareFileVisual({ mime: "application/octet-stream", name: "a.tar.gz" })).toBe("archive")
    expect(shareFileVisual({ mime: "audio/mpeg", name: "a.mp3" })).toBe("audio")
    expect(shareFileVisual({ mime: "video/mp4", name: "a.mp4" })).toBe("video")
    expect(shareFileVisual({ mime: "application/octet-stream", name: "blob" })).toBe("other")
  })
})

describe("sharePreviewKind", () => {
  it("previews images, PDFs and text within their caps, never SVG", () => {
    expect(sharePreviewKind({ mime: "image/png", size: 1 })).toBe("image")
    expect(sharePreviewKind({ mime: "image/svg+xml", size: 1 })).toBeNull()
    expect(sharePreviewKind({ mime: "application/pdf", size: 1 })).toBe("pdf")
    expect(sharePreviewKind({ mime: "text/markdown", size: 1 })).toBe("text")
    expect(sharePreviewKind({ mime: "application/json", size: 1 })).toBe("text")
    expect(
      sharePreviewKind({ mime: "text/plain", size: SHARE_TEXT_PREVIEW_MAX_BYTES + 1 })
    ).toBeNull()
    expect(
      sharePreviewKind({ mime: "image/png", size: SHARE_MEDIA_PREVIEW_MAX_BYTES + 1 })
    ).toBeNull()
    expect(sharePreviewKind({ mime: "application/zip", size: 1 })).toBeNull()
  })
})

// jsdom's Blob has no `text()`; the browser's does.
function textBlob(value: string): Blob {
  return Object.assign(new Blob([value], { type: "text/plain" }), { text: async () => value })
}

describe("ShareFilesSection as a page (file-bundle)", () => {
  it("heads the page with the share's title, size, encryption and download window", () => {
    download.mockReturnValue(new Promise(() => {}))
    render(
      <ShareFilesSection
        variant="page"
        title="Files from Quarterly report"
        files={[entry("a.txt", "text/plain", 1024), entry("b.zip", "application/zip", 1024)]}
        access={ACCESS}
      />
    )
    expect(screen.getByRole("region", { name: "Files from Quarterly report" })).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { level: 1, name: "Files from Quarterly report" })
    ).toBeInTheDocument()
    expect(screen.getByText("2 files · 2.0 KB")).toBeInTheDocument()
    expect(screen.getByText("End-to-end encrypted")).toBeInTheDocument()
    expect(screen.getByText(/Downloadable until/)).toBeInTheDocument()
    expect(screen.getByRole("list", { name: "Files in this share" })).toBeInTheDocument()
  })

  it("opens on its first file and loads a small preview straight away", async () => {
    download.mockResolvedValue(textBlob("<b>not markup</b>"))
    render(
      <ShareFilesSection
        variant="page"
        files={[entry("note.md", "text/markdown"), entry("b.zip", "application/zip")]}
        access={ACCESS}
      />
    )
    expect(screen.getByRole("button", { name: "Show note.md" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    // Plain text, never markup.
    expect(await screen.findByText("<b>not markup</b>")).toBeInTheDocument()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it("says a file cannot be previewed and offers it as a download", async () => {
    const user = userEvent.setup()
    download.mockResolvedValue(textBlob("x"))
    render(
      <ShareFilesSection
        variant="page"
        files={[entry("a.txt", "text/plain"), entry("b.zip", "application/zip")]}
        access={ACCESS}
      />
    )
    await user.click(screen.getByRole("button", { name: "Show b.zip" }))
    const pane = screen.getByRole("region", { name: "Preview" })
    expect(within(pane).getByText(/can’t be previewed here/)).toBeInTheDocument()
    download.mockResolvedValueOnce(new Blob(["zip"]))
    await user.click(within(pane).getByRole("button", { name: "Download" }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.any(Blob), "b.zip"))
  })

  it("waits to be asked before loading a large preview", async () => {
    const user = userEvent.setup()
    download.mockResolvedValue(new Blob([new Uint8Array([1])], { type: "image/png" }))
    render(
      <ShareFilesSection
        variant="page"
        files={[entry("big.png", "image/png", SHARE_AUTO_PREVIEW_MAX_BYTES + 1)]}
        access={ACCESS}
      />
    )
    expect(download).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: /^Show preview/ }))
    expect(await screen.findByRole("img", { name: "big.png" })).toHaveAttribute(
      "src",
      "blob:preview"
    )
  })
})

describe("ShareFilesSection as attachments", () => {
  it("lists the files under an Attachments heading and previews nothing until picked", () => {
    render(<ShareFilesSection files={[entry("a.txt", "text/plain", 1024)]} access={ACCESS} />)
    expect(screen.getByRole("region", { name: "Attachments" })).toBeInTheDocument()
    expect(screen.getByText("1 file · 1.0 KB")).toBeInTheDocument()
    expect(screen.getByText("Choose a file to preview it here.")).toBeInTheDocument()
    expect(download).not.toHaveBeenCalled()
  })

  it("lists without downloads or a preview in the owner's preview", () => {
    render(<ShareFilesSection files={[entry("a.txt", "text/plain")]} />)
    expect(screen.getByText("a.txt")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Download a.txt" })).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Preview" })).not.toBeInTheDocument()
    expect(screen.queryByText(/can’t serve files/)).not.toBeInTheDocument()
  })

  it("explains a server that issued no read ticket", () => {
    const { readTicket: _ticket, ...noTicket } = ACCESS
    render(<ShareFilesSection files={[entry("a.txt", "text/plain")]} access={noTicket} />)
    expect(screen.getByText(/can’t serve files/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Download a.txt" })).not.toBeInTheDocument()
  })

  it("decrypts a file once and reuses it for the preview and later downloads", async () => {
    const user = userEvent.setup()
    const blob = textBlob("hello")
    download.mockResolvedValue(blob)
    render(<ShareFilesSection files={[entry("a.txt", "text/plain")]} access={ACCESS} />)

    await user.click(screen.getByRole("button", { name: "Download a.txt" }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(blob, "a.txt"))
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: ACCESS.baseUrl,
        code: ACCESS.code,
        readTicket: ACCESS.readTicket,
        material: ACCESS.material,
      })
    )
    await user.click(screen.getByRole("button", { name: "Show a.txt" }))
    expect(await screen.findByText("hello")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Download a.txt" }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(download).toHaveBeenCalledTimes(1)
  })

  it("says why a download failed, in the row and the preview", async () => {
    const user = userEvent.setup()
    download.mockRejectedValueOnce(new ShareTicketExpiredError())
    download.mockRejectedValueOnce(new ShareFileIntegrityError("/workspace/b.bin"))
    render(
      <ShareFilesSection
        files={[
          entry("a.bin", "application/octet-stream"),
          entry("b.bin", "application/octet-stream"),
        ]}
        access={ACCESS}
      />
    )
    await user.click(screen.getByRole("button", { name: "Download a.bin" }))
    expect(await screen.findByText(/download window for this link has closed/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Download b.bin" }))
    await user.click(screen.getByRole("button", { name: "Show b.bin" }))
    expect(await screen.findAllByText(/failed its integrity check/)).toHaveLength(2)
    expect(save).not.toHaveBeenCalled()
  })
})
