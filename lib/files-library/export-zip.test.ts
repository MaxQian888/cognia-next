jest.mock("./download", () => ({ downloadPayloadFor: jest.fn() }))

import { strFromU8, unzipSync } from "fflate"

import type { LibraryFolder } from "@/lib/db/files-library-types"

import { downloadPayloadFor } from "./download"
import {
  buildFilesZip,
  FILES_ZIP_MAX_BYTES,
  FilesExportError,
  numberedPath,
  zipFolderPath,
} from "./export-zip"
import type { FilesEntry } from "./types"

const payloadMock = downloadPayloadFor as jest.Mock

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "key">): FilesEntry {
  return {
    kind: "upload",
    sourceId: overrides.key,
    title: overrides.key,
    sourceTitle: overrides.key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: true,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    ...overrides,
  }
}

function folder(id: string, name: string, parentFolderId = "root"): LibraryFolder {
  return { id, name, parentFolderId, createdAt: 1, updatedAt: 1 }
}

const folders = [
  folder("lbf_work", "Work"),
  folder("lbf_q3", "Q3: plans", "lbf_work"),
  folder("lbf_empty", "   "),
]

async function unzip(blob: Blob): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, strFromU8(bytes)]))
}

/** Payloads keyed by entry key; a missing key means the content is gone. */
function payloads(map: Record<string, { text: string; filename: string; type?: string }>) {
  return async (e: FilesEntry) => {
    const hit = map[e.key]
    return hit
      ? { blob: new Blob([hit.text], { type: hit.type ?? "" }), filename: hit.filename }
      : null
  }
}

beforeEach(() => jest.clearAllMocks())

describe("numberedPath", () => {
  it("numbers before the extension", () => {
    expect(numberedPath("a.txt", 2)).toBe("a (2).txt")
    expect(numberedPath("dir/sub/a.tar.gz", 3)).toBe("dir/sub/a.tar (3).gz")
  })

  it("appends for names without an extension or dotfiles", () => {
    expect(numberedPath("README", 2)).toBe("README (2)")
    expect(numberedPath("dir/.env", 2)).toBe("dir/.env (2)")
    expect(numberedPath("dir.d/file", 4)).toBe("dir.d/file (4)")
  })
})

describe("zipFolderPath", () => {
  it("puts unfiled and root entries at the archive root", () => {
    expect(zipFolderPath({}, folders)).toBe("")
    expect(zipFolderPath({ folderId: "root" }, folders)).toBe("")
  })

  it("writes the folder chain with filesystem-safe names", () => {
    expect(zipFolderPath({ folderId: "lbf_work" }, folders)).toBe("Work")
    expect(zipFolderPath({ folderId: "lbf_q3" }, folders)).toBe("Work/Q3_ plans")
    expect(zipFolderPath({ folderId: "lbf_empty" }, folders)).toBe("folder")
  })

  it("puts an entry whose folder no longer exists at the root", () => {
    expect(zipFolderPath({ folderId: "lbf_gone" }, folders)).toBe("")
  })
})

describe("buildFilesZip", () => {
  it("writes each entry under its folder path", async () => {
    const entries = [
      entry({ key: "a" }),
      entry({ key: "b", folderId: "lbf_work" }),
      entry({ key: "c", folderId: "lbf_q3" }),
      entry({ key: "d", folderId: "root" }),
    ]
    const result = await buildFilesZip(entries, folders, {
      payloadFor: payloads({
        a: { text: "A", filename: "a.txt" },
        b: { text: "B", filename: "b.md" },
        c: { text: "C", filename: "c.png", type: "image/png" },
        d: { text: "D", filename: "d.json" },
      }),
    })
    expect(result.written).toBe(4)
    expect(result.missing).toEqual([])
    expect(result.blob.type).toBe("application/zip")
    expect(await unzip(result.blob)).toEqual({
      "a.txt": "A",
      "Work/b.md": "B",
      "Work/Q3_ plans/c.png": "C",
      "d.json": "D",
    })
  })

  it("numbers entries whose paths collide, ignoring case", async () => {
    const entries = [
      entry({ key: "1" }),
      entry({ key: "2" }),
      entry({ key: "3" }),
      entry({ key: "4", folderId: "lbf_work" }),
    ]
    const result = await buildFilesZip(entries, folders, {
      payloadFor: payloads({
        "1": { text: "one", filename: "Notes.md" },
        "2": { text: "two", filename: "notes.md" },
        "3": { text: "three", filename: "NOTES.md" },
        "4": { text: "four", filename: "notes.md" },
      }),
    })
    expect(await unzip(result.blob)).toEqual({
      "Notes.md": "one",
      "notes (2).md": "two",
      "NOTES (3).md": "three",
      "Work/notes.md": "four",
    })
  })

  it("reports entries whose content is gone and writes the rest", async () => {
    const gone = entry({ key: "gone" })
    const result = await buildFilesZip([entry({ key: "a" }), gone], [], {
      payloadFor: payloads({ a: { text: "A", filename: "a.txt" } }),
    })
    expect(result.written).toBe(1)
    expect(result.missing).toEqual([gone])
    expect(await unzip(result.blob)).toEqual({ "a.txt": "A" })
  })

  it("refuses an empty selection", async () => {
    const payloadFor = jest.fn()
    const error = await buildFilesZip([], folders, { payloadFor }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FilesExportError)
    expect((error as FilesExportError).code).toBe("files_export_empty")
    expect(payloadFor).not.toHaveBeenCalled()
  })

  it("refuses a selection whose content is all gone", async () => {
    const error = await buildFilesZip([entry({ key: "a" }), entry({ key: "b" })], [], {
      payloadFor: payloads({}),
    }).catch((e: unknown) => e)
    expect((error as FilesExportError).code).toBe("files_export_empty")
  })

  it("refuses a selection whose known size is over the cap before reading anything", async () => {
    const payloadFor = jest.fn()
    const error = await buildFilesZip(
      [entry({ key: "a", byteSize: FILES_ZIP_MAX_BYTES }), entry({ key: "b", byteSize: 1 })],
      [],
      { payloadFor }
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FilesExportError)
    expect((error as FilesExportError).code).toBe("files_export_too_large")
    expect(payloadFor).not.toHaveBeenCalled()
  })

  it("stops when the bytes actually read pass the cap", async () => {
    const payloadFor = jest.fn(async () => {
      const blob = new Blob(["x"])
      Object.defineProperty(blob, "size", { value: FILES_ZIP_MAX_BYTES / 2 + 1 })
      return { blob, filename: "big.bin" }
    })
    const error = await buildFilesZip(
      [entry({ key: "a" }), entry({ key: "b" }), entry({ key: "c" })],
      [],
      { payloadFor }
    ).catch((e: unknown) => e)
    expect((error as FilesExportError).code).toBe("files_export_too_large")
    expect(payloadFor).toHaveBeenCalledTimes(2)
  })

  it("defaults to downloadPayloadFor", async () => {
    payloadMock.mockResolvedValue({ blob: new Blob(["hi"]), filename: "hi.txt" })
    const e = entry({ key: "a" })
    const result = await buildFilesZip([e], [])
    expect(payloadMock).toHaveBeenCalledWith(e)
    expect(await unzip(result.blob)).toEqual({ "hi.txt": "hi" })
  })
})
