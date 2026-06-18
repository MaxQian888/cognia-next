/**
 * @jest-environment jsdom
 */
import { encodeBase64 } from "@/lib/share/encoding"

const isTauriMock = jest.fn().mockReturnValue(false)
const isCapacitorMock = jest.fn().mockReturnValue(false)
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => isTauriMock(),
  isCapacitor: () => isCapacitorMock(),
}))

const registerDialogPathInRustMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/files/allowed-roots-sync", () => ({
  registerDialogPathInRust: (...a: unknown[]) => registerDialogPathInRustMock(...a),
}))

const capWriteFileMock = jest.fn()
jest.mock("@/lib/capacitor/filesystem", () => ({
  writeFile: (opts: unknown) => capWriteFileMock(opts),
}))

const downloadBlobMock = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a),
}))

const saveDialogMock = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({ save: (args: unknown) => saveDialogMock(args) }), {
  virtual: true,
})

const fsWriteTextFileMock = jest.fn().mockResolvedValue(undefined)
const fsWriteFileMock = jest.fn().mockResolvedValue(undefined)
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    writeTextFile: (...a: unknown[]) => fsWriteTextFileMock(...a),
    writeFile: (...a: unknown[]) => fsWriteFileMock(...a),
  }),
  { virtual: true }
)

import { saveExport } from "./save-export"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(false)
  isCapacitorMock.mockReset().mockReturnValue(false)
  registerDialogPathInRustMock.mockClear()
  capWriteFileMock.mockReset()
  downloadBlobMock.mockReset()
  saveDialogMock.mockReset()
  fsWriteTextFileMock.mockReset().mockResolvedValue(undefined)
  fsWriteFileMock.mockReset().mockResolvedValue(undefined)
})

describe("saveExport — Tauri", () => {
  beforeEach(() => isTauriMock.mockReturnValue(true))

  it("writes a string via writeTextFile and registers the chosen path", async () => {
    saveDialogMock.mockResolvedValueOnce("/picked/out.md")
    const res = await saveExport({ filename: "out.md", data: "# hi", mimeType: "text/markdown" })
    expect(registerDialogPathInRustMock).toHaveBeenCalledWith("/picked/out.md")
    expect(fsWriteTextFileMock).toHaveBeenCalledWith("/picked/out.md", "# hi")
    expect(res).toEqual({
      kind: "saved",
      platform: "tauri",
      location: "/picked/out.md",
      filename: "out.md",
    })
  })

  it("writes binary data via writeFile", async () => {
    saveDialogMock.mockResolvedValueOnce("/picked/out.zip")
    const bytes = new Uint8Array([1, 2, 3])
    const res = await saveExport({ filename: "out.zip", data: bytes, mimeType: "application/zip" })
    expect(fsWriteFileMock).toHaveBeenCalledWith("/picked/out.zip", bytes)
    expect(res).toMatchObject({ kind: "saved", platform: "tauri" })
  })

  it("returns cancelled when the dialog is dismissed", async () => {
    saveDialogMock.mockResolvedValueOnce(null)
    const res = await saveExport({ filename: "out.md", data: "x", mimeType: "text/markdown" })
    expect(res).toEqual({ kind: "cancelled" })
    expect(fsWriteTextFileMock).not.toHaveBeenCalled()
  })

  it("derives the dialog filter from the extension when none given", async () => {
    saveDialogMock.mockResolvedValueOnce("/x/noext")
    await saveExport({ filename: "noext", data: "x", mimeType: "text/plain" })
    expect(saveDialogMock.mock.calls[0][0].filters[0].extensions[0]).toBe("txt")
  })

  it("honours an explicit filters override", async () => {
    saveDialogMock.mockResolvedValueOnce("/x/out.zip")
    await saveExport({
      filename: "out.zip",
      data: new Uint8Array(),
      mimeType: "application/zip",
      filters: [{ name: "Archive", extensions: ["zip", "gz"] }],
    })
    expect(saveDialogMock.mock.calls[0][0].filters).toEqual([
      { name: "Archive", extensions: ["zip", "gz"] },
    ])
  })

  it("maps a thrown error to an error outcome", async () => {
    saveDialogMock.mockRejectedValueOnce(new Error("dialog boom"))
    const res = await saveExport({ filename: "out.md", data: "x", mimeType: "text/markdown" })
    expect(res).toEqual({ kind: "error", message: "dialog boom" })
  })
})

describe("saveExport — Capacitor", () => {
  beforeEach(() => isCapacitorMock.mockReturnValue(true))

  it("writes base64 into Documents and returns the file uri", async () => {
    capWriteFileMock.mockResolvedValueOnce({ kind: "ok", value: { uri: "file:///docs/x.md" } })
    const res = await saveExport({ filename: "x.md", data: "hi", mimeType: "text/markdown" })
    expect(capWriteFileMock).toHaveBeenCalledWith({
      path: "cognia/exports/x.md",
      data: encodeBase64(new TextEncoder().encode("hi")),
      encoding: "base64",
      directory: "documents",
      recursive: true,
    })
    expect(res).toEqual({
      kind: "saved",
      platform: "mobile",
      location: "file:///docs/x.md",
      uri: "file:///docs/x.md",
      filename: "x.md",
    })
  })

  it("honours a custom mobileSubdir", async () => {
    capWriteFileMock.mockResolvedValueOnce({ kind: "ok", value: { uri: "u" } })
    await saveExport({
      filename: "b.bak",
      data: "x",
      mimeType: "application/octet-stream",
      mobileSubdir: "cognia/backups",
    })
    expect(capWriteFileMock.mock.calls[0][0].path).toBe("cognia/backups/b.bak")
  })

  it("falls back to a web download when the plugin is unsupported", async () => {
    capWriteFileMock.mockResolvedValueOnce({ kind: "unsupported" })
    const res = await saveExport({ filename: "x.md", data: "hi", mimeType: "text/markdown" })
    expect(downloadBlobMock).toHaveBeenCalled()
    expect(res).toMatchObject({ kind: "saved", platform: "web" })
  })

  it("surfaces a plugin error", async () => {
    capWriteFileMock.mockResolvedValueOnce({ kind: "error", message: "disk full" })
    const res = await saveExport({ filename: "x.md", data: "hi", mimeType: "text/markdown" })
    expect(res).toEqual({ kind: "error", message: "disk full" })
  })

  it("encodes binary blobs to base64", async () => {
    capWriteFileMock.mockResolvedValueOnce({ kind: "ok", value: { uri: "u" } })
    // jsdom Blob lacks arrayBuffer(); real Capacitor webview Blobs have it.
    const blob = {
      arrayBuffer: async () => new Uint8Array([65, 66, 67]).buffer,
    } as unknown as Blob
    await saveExport({ filename: "x.bin", data: blob, mimeType: "application/octet-stream" })
    expect(capWriteFileMock.mock.calls[0][0].data).toBe(encodeBase64(new Uint8Array([65, 66, 67])))
  })
})

describe("saveExport — web", () => {
  it("downloads a string as a Blob and reports the downloads location", async () => {
    const res = await saveExport({ filename: "x.md", data: "hi", mimeType: "text/markdown" })
    expect(downloadBlobMock).toHaveBeenCalledTimes(1)
    const [blobArg, nameArg] = downloadBlobMock.mock.calls[0]
    expect(blobArg).toBeInstanceOf(Blob)
    expect(nameArg).toBe("x.md")
    expect(res).toEqual({
      kind: "saved",
      platform: "web",
      location: "downloads",
      filename: "x.md",
    })
  })

  it("passes a Blob through unchanged", async () => {
    const blob = new Blob(["data"])
    await saveExport({ filename: "x.bin", data: blob, mimeType: "application/octet-stream" })
    expect(downloadBlobMock.mock.calls[0][0]).toBe(blob)
  })
})
