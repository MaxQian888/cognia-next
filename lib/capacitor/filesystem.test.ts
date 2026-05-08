/**
 * @jest-environment jsdom
 */
import { deleteFile, listDir, mkdir, readFile, writeFile } from "./filesystem"

function makeFs() {
  return {
    writeFile: jest.fn().mockResolvedValue({ uri: "file:///tmp/x.bak" }),
    readFile: jest.fn().mockResolvedValue({ data: "PAYLOAD" }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue({
      files: [{ name: "a.bak", type: "file", size: 12, mtime: 1, uri: "file://a" }],
    }),
    stat: jest.fn(),
  }
}

describe("filesystem.writeFile", () => {
  it("maps directory + encoding and returns uri", async () => {
    const fs = makeFs()
    const out = await writeFile({
      path: "cognia/backups/t.bak",
      data: "ZGF0YQ==",
      directory: "documents",
      encoding: "base64",
      loader: async () => fs,
    })
    expect(fs.writeFile).toHaveBeenCalledWith({
      path: "cognia/backups/t.bak",
      data: "ZGF0YQ==",
      directory: "DOCUMENTS",
      encoding: undefined,
      recursive: true,
    })
    expect(out).toEqual({ kind: "ok", value: { uri: "file:///tmp/x.bak" } })
  })

  it("forwards utf8 encoding to plugin", async () => {
    const fs = makeFs()
    await writeFile({
      path: "x.json",
      data: "{}",
      encoding: "utf8",
      loader: async () => fs,
    })
    expect(fs.writeFile).toHaveBeenCalledWith(expect.objectContaining({ encoding: "utf8" }))
  })

  it("returns unsupported when plugin missing", async () => {
    const out = await writeFile({
      path: "x",
      data: "y",
      loader: async () => {
        throw new Error("not native")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})

describe("filesystem.readFile", () => {
  it("returns string data verbatim", async () => {
    const fs = makeFs()
    const out = await readFile({
      path: "x",
      loader: async () => fs,
    })
    expect(out).toEqual({ kind: "ok", value: "PAYLOAD" })
  })

  it("converts blob to text fallback", async () => {
    const fs = makeFs()
    // jsdom's Blob lacks .text(); fake one that mimics the real shape.
    const fakeBlob = { text: async () => "hello" } as unknown as Blob
    fs.readFile.mockResolvedValue({ data: fakeBlob })
    const out = await readFile({ path: "x", loader: async () => fs })
    expect(out).toEqual({ kind: "ok", value: "hello" })
  })
})

describe("filesystem.deleteFile / mkdir / listDir", () => {
  it("deleteFile passes directory map", async () => {
    const fs = makeFs()
    await deleteFile({ path: "x", directory: "data", loader: async () => fs })
    expect(fs.deleteFile).toHaveBeenCalledWith({ path: "x", directory: "DATA" })
  })

  it("mkdir passes recursive default", async () => {
    const fs = makeFs()
    await mkdir({ path: "cognia/backups", loader: async () => fs })
    expect(fs.mkdir).toHaveBeenCalledWith({
      path: "cognia/backups",
      directory: "DOCUMENTS",
      recursive: true,
    })
  })

  it("listDir returns the file array", async () => {
    const fs = makeFs()
    const out = await listDir({ path: "cognia/backups", loader: async () => fs })
    expect(out).toEqual({
      kind: "ok",
      value: [{ name: "a.bak", type: "file", size: 12, mtime: 1, uri: "file://a" }],
    })
  })
})
