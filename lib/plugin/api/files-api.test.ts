jest.mock("@/lib/files/save-export", () => ({ saveExport: jest.fn() }))
jest.mock("@/lib/platform/detect", () => ({
  isCapacitor: jest.fn(() => false),
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadBinaryFiles: jest.fn(),
  saveBinaryFileAs: jest.fn(),
}))

import { pickAndReadBinaryFiles, saveBinaryFileAs } from "@/lib/files/file-bridge"
import { saveExport } from "@/lib/files/save-export"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { initializePluginPermissions } from "./permission-api"
import { authorizePluginAttachment, createFilesAPI, revokePluginFileHandles } from "./files-api"

const pick = jest.mocked(pickAndReadBinaryFiles)
const save = jest.mocked(saveBinaryFileAs)
const saveMobile = jest.mocked(saveExport)
const onCapacitor = jest.mocked(isCapacitor)
const onTauri = jest.mocked(isTauri)

beforeEach(() => {
  jest.clearAllMocks()
  initializePluginPermissions("office", ["filesystem:read", "filesystem:write"])
  initializePluginPermissions("other", ["filesystem:read"])
  revokePluginFileHandles("office")
  revokePluginFileHandles("other")
})

it("returns bytes without exposing the selected filesystem path", async () => {
  pick.mockResolvedValue([
    { name: "book.xlsx", path: "/secret/book.xlsx", bytes: new Uint8Array([1, 2]) },
  ])
  const [file] = await createFilesAPI("office").open({ accept: [".xlsx"], maxBytes: 10 })
  expect(file).toMatchObject({ name: "book.xlsx", size: 2, bytes: new Uint8Array([1, 2]) })
  expect(file).not.toHaveProperty("path")
})

it("rejects oversized files", async () => {
  pick.mockResolvedValue([{ name: "book.xlsx", path: "", bytes: new Uint8Array([1, 2]) }])
  await expect(createFilesAPI("office").open({ maxBytes: 1 })).rejects.toThrow("maxBytes")
})

it("returns an empty list when the user cancels file selection", async () => {
  pick.mockResolvedValue([])
  await expect(createFilesAPI("office").open({ accept: [".xlsx"] })).resolves.toEqual([])
})

it("enforces extension and MIME accept filters after selection", async () => {
  pick.mockResolvedValue([
    { name: "notes.txt", path: "/secret/notes.txt", bytes: new Uint8Array([1]) },
  ])
  await expect(createFilesAPI("office").open({ accept: [".xlsx"] })).rejects.toThrow(
    "accepted types"
  )

  pick.mockResolvedValue([
    { name: "book.xlsx", path: "/secret/book.xlsx", bytes: new Uint8Array([1]) },
  ])
  await expect(
    createFilesAPI("office").open({
      accept: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    })
  ).resolves.toHaveLength(1)
})

it("scopes attachment handles to the authorized plugin", async () => {
  const handle = authorizePluginAttachment("office", {
    name: "book.xlsx",
    mimeType: "application/octet-stream",
    size: 1,
    bytes: new Uint8Array([7]),
  })
  await expect(createFilesAPI("office").readAttachment(handle)).resolves.toMatchObject({
    name: "book.xlsx",
  })
  await expect(createFilesAPI("other").readAttachment(handle)).rejects.toThrow("not authorized")
})

it("saves bytes through the cross-platform bridge", async () => {
  save.mockResolvedValue(true)
  await expect(
    createFilesAPI("office").save({
      suggestedName: "book.xlsx",
      mimeType: "application/octet-stream",
      bytes: new Uint8Array([9]),
    })
  ).resolves.toEqual({ saved: true, platform: "web", location: "downloads" })
})

it("reports a cancelled desktop save dialog as not saved", async () => {
  onTauri.mockReturnValueOnce(true)
  save.mockResolvedValue(false)
  await expect(
    createFilesAPI("office").save({
      suggestedName: "book.xlsx",
      mimeType: "application/octet-stream",
      bytes: new Uint8Array([9]),
    })
  ).resolves.toEqual({ saved: false })
})

it("writes into Documents on mobile instead of a download anchor the WebView ignores", async () => {
  onCapacitor.mockReturnValue(true)
  saveMobile.mockResolvedValue({
    kind: "saved",
    platform: "mobile",
    location: "file:///Documents/cognia/exports/book.xlsx",
    filename: "book.xlsx",
  })
  await expect(
    createFilesAPI("office").save({
      suggestedName: "book.xlsx",
      mimeType: "application/octet-stream",
      bytes: new Uint8Array([9]),
    })
  ).resolves.toEqual({
    saved: true,
    platform: "mobile",
    location: "file:///Documents/cognia/exports/book.xlsx",
  })
  expect(saveMobile).toHaveBeenCalledWith(
    expect.objectContaining({ filename: "book.xlsx", mimeType: "application/octet-stream" })
  )
  expect(save).not.toHaveBeenCalled()

  saveMobile.mockResolvedValue({ kind: "error", message: "disk full" })
  await expect(
    createFilesAPI("office").save({
      suggestedName: "book.xlsx",
      mimeType: "application/octet-stream",
      bytes: new Uint8Array([9]),
    })
  ).rejects.toThrow("disk full")
  onCapacitor.mockReturnValue(false)
})

it("rejects save suggestions that try to expose a filesystem path", async () => {
  await expect(
    createFilesAPI("office").save({
      suggestedName: "../book.xlsx",
      mimeType: "application/octet-stream",
      bytes: new Uint8Array([9]),
    })
  ).rejects.toThrow("without a path")
  expect(save).not.toHaveBeenCalled()
})
