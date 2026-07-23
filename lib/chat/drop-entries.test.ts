import { collectDroppedFiles, MAX_DROPPED_DIR_FILES } from "./drop-entries"

type Entry =
  | { isFile: true; isDirectory: false; name: string; file: (ok: (f: File) => void) => void }
  | {
      isFile: false
      isDirectory: true
      name: string
      createReader: () => { readEntries: (ok: (batch: Entry[]) => void) => void }
    }

function fileEntry(name: string, body = "x"): Entry {
  const file = new File([body], name, { type: "text/plain" })
  return { isFile: true, isDirectory: false, name, file: (ok) => ok(file) }
}

function dirEntry(name: string, children: Entry[]): Entry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      // A real FileSystemDirectoryReader hands back one batch per call and
      // signals completion with an empty batch — mirror that here.
      let done = false
      return {
        readEntries: (ok) => {
          if (done) {
            ok([])
            return
          }
          done = true
          ok(children)
        },
      }
    },
  }
}

function dataTransfer(entries: Entry[] | null, files: File[] = []): DataTransfer {
  return {
    files: files as unknown as FileList,
    items: (entries ?? []).map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
  } as unknown as DataTransfer
}

describe("collectDroppedFiles", () => {
  it("falls back to dataTransfer.files when no entry API is exposed", async () => {
    const plain = new File(["hi"], "note.md", { type: "text/markdown" })
    const result = await collectDroppedFiles(dataTransfer(null, [plain]))

    expect(result.files).toEqual([plain])
    expect(result.directories).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it("flattens a dropped directory and names files by their relative path", async () => {
    const dt = dataTransfer([
      fileEntry("top.txt"),
      dirEntry("docs", [fileEntry("readme.md"), dirEntry("api", [fileEntry("v1.md")])]),
    ])

    const result = await collectDroppedFiles(dt)

    expect(result.files.map((f) => f.name)).toEqual(["top.txt", "docs/readme.md", "docs/api/v1.md"])
    expect(result.directories).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it("stops at the walk cap and reports truncation", async () => {
    const children = Array.from({ length: MAX_DROPPED_DIR_FILES + 5 }, (_, i) =>
      fileEntry(`f${i}.txt`)
    )
    const result = await collectDroppedFiles(dataTransfer([dirEntry("big", children)]))

    expect(result.files).toHaveLength(MAX_DROPPED_DIR_FILES)
    expect(result.truncated).toBe(true)
  })

  it("skips unreadable entries instead of failing the whole drop", async () => {
    const unreadable: Entry = {
      isFile: true,
      isDirectory: false,
      name: "locked.txt",
      file: (_ok, fail?: (err: unknown) => void) => fail?.(new Error("denied")),
    } as Entry
    const dt = {
      files: [] as unknown as FileList,
      items: [
        { kind: "string", webkitGetAsEntry: () => fileEntry("ignored.txt") },
        { kind: "file" },
        { kind: "file", webkitGetAsEntry: () => null },
        { kind: "file", webkitGetAsEntry: () => unreadable },
        { kind: "file", webkitGetAsEntry: () => fileEntry("ok.txt") },
      ],
    } as unknown as DataTransfer

    const result = await collectDroppedFiles(dt)

    expect(result.files.map((f) => f.name)).toEqual(["ok.txt"])
    expect(result.directories).toBe(0)
  })

  it("keeps the files already read when a directory listing errors", async () => {
    const failing = {
      isFile: false,
      isDirectory: true,
      name: "broken",
      createReader: () => ({
        readEntries: (_ok: unknown, fail?: (err: unknown) => void) => fail?.(new Error("io")),
      }),
    } as unknown as Entry

    const result = await collectDroppedFiles(dataTransfer([fileEntry("kept.txt"), failing]))

    expect(result.files.map((f) => f.name)).toEqual(["kept.txt"])
    expect(result.directories).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it("reports an empty directory without inventing an attachment", async () => {
    const result = await collectDroppedFiles(dataTransfer([dirEntry("empty", [])]))

    expect(result.files).toEqual([])
    expect(result.directories).toBe(1)
  })
})
