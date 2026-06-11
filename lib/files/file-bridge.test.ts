jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

const mockOpen = jest.fn()
const mockSave = jest.fn()
jest.mock(
  "@tauri-apps/plugin-dialog",
  () => ({
    open: (...args: unknown[]) => mockOpen(...args),
    save: (...args: unknown[]) => mockSave(...args),
  }),
  { virtual: true }
)

jest.mock("@/lib/claude/ipc", () => ({
  defaultExportDir: jest.fn(),
  readTextFile: jest.fn(),
  writeTextFile: jest.fn(),
  writeTextFileConfined: jest.fn(),
}))

const mockReadBinary = jest.fn()
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    readFile: (...args: unknown[]) => mockReadBinary(...args),
  }),
  { virtual: true }
)

import { isTauri } from "@/lib/tauri"
import {
  defaultExportDir,
  readTextFile,
  writeTextFile,
  writeTextFileConfined,
} from "@/lib/claude/ipc"
import {
  pickAndReadFiles,
  pickAndReadBinaryFiles,
  saveFileAs,
  pickDirectory,
  saveFilesToDir,
} from "./file-bridge"

const mockedIsTauri = isTauri as unknown as jest.Mock
const mockedDefaultExportDir = defaultExportDir as unknown as jest.Mock
const mockedRead = readTextFile as unknown as jest.Mock
const mockedWrite = writeTextFile as unknown as jest.Mock
const mockedWriteConfined = writeTextFileConfined as unknown as jest.Mock

beforeEach(() => {
  mockedIsTauri.mockReset()
  mockedDefaultExportDir.mockReset()
  mockedRead.mockReset()
  mockedWrite.mockReset()
  mockedWriteConfined.mockReset()
  mockOpen.mockReset()
  mockSave.mockReset()
  mockReadBinary.mockReset()
})

describe("pickAndReadFiles — Tauri branch", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("returns [] when the user cancels", async () => {
    mockOpen.mockResolvedValue(null)
    const out = await pickAndReadFiles()
    expect(out).toEqual([])
  })

  it("reads single picked file", async () => {
    mockOpen.mockResolvedValue("/abs/path/file.txt")
    mockedRead.mockResolvedValue("hello")
    const out = await pickAndReadFiles()
    expect(out).toEqual([{ name: "file.txt", path: "/abs/path/file.txt", content: "hello" }])
  })

  it("reads multiple picked files and skips errored reads", async () => {
    mockOpen.mockResolvedValue(["/a/b.txt", "/x/y.txt"])
    mockedRead.mockResolvedValueOnce("aaa").mockRejectedValueOnce(new Error("nope"))
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const out = await pickAndReadFiles({ multiple: true })
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ name: "b.txt", path: "/a/b.txt", content: "aaa" })
    consoleSpy.mockRestore()
  })

  it("handles backslash separators in basename derivation", async () => {
    mockOpen.mockResolvedValue("C:\\Users\\demo\\file.md")
    mockedRead.mockResolvedValue("md")
    const out = await pickAndReadFiles()
    expect(out[0].name).toBe("file.md")
  })

  it("returns bare path when there is no separator", async () => {
    mockOpen.mockResolvedValue("plain")
    mockedRead.mockResolvedValue("x")
    const out = await pickAndReadFiles()
    expect(out[0].name).toBe("plain")
  })

  it("passes filters and multiple flag", async () => {
    mockOpen.mockResolvedValue([])
    await pickAndReadFiles({ multiple: true, filters: [{ name: "MD", extensions: ["md"] }] })
    expect(mockOpen).toHaveBeenCalledWith({
      multiple: true,
      directory: false,
      filters: [{ name: "MD", extensions: ["md"] }],
    })
  })
})

describe("pickAndReadFiles — browser branch", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(false))

  it("returns [] on cancel", async () => {
    const fakeInput = {
      type: "",
      multiple: false,
      accept: "",
      files: null as FileList | null,
      onchange: null as null | (() => Promise<void>),
      oncancel: null as null | (() => void),
      click() {
        // simulate a cancel
        this.oncancel?.()
      },
    }
    const spy = jest
      .spyOn(document, "createElement")
      .mockReturnValueOnce(fakeInput as unknown as HTMLElement)
    const out = await pickAndReadFiles()
    expect(out).toEqual([])
    spy.mockRestore()
  })

  it("returns [] when files list is empty after change", async () => {
    const fakeInput: {
      type: string
      multiple: boolean
      accept: string
      files: FileList | null
      onchange: null | (() => Promise<void>)
      oncancel: null | (() => void)
      click(): void
    } = {
      type: "",
      multiple: false,
      accept: "",
      files: null,
      onchange: null,
      oncancel: null,
      click() {
        this.files = { length: 0, item: () => null } as unknown as FileList
        ;(this.onchange as () => Promise<void>)?.()
      },
    }
    const spy = jest
      .spyOn(document, "createElement")
      .mockReturnValueOnce(fakeInput as unknown as HTMLElement)
    const out = await pickAndReadFiles()
    expect(out).toEqual([])
    spy.mockRestore()
  })

  it("reads file contents via File.text()", async () => {
    const fakeFile = {
      name: "a.txt",
      text: jest.fn(async () => "AAA"),
    }
    const fakeInput: {
      type: string
      multiple: boolean
      accept: string
      files: FileList | null
      onchange: null | (() => Promise<void>)
      oncancel: null | (() => void)
      click(): void
    } = {
      type: "",
      multiple: true,
      accept: "",
      files: null,
      onchange: null,
      oncancel: null,
      click() {
        const list = [fakeFile] as unknown as FileList
        // Provide minimal FileList-like behavior
        Object.assign(list, { length: 1 })
        this.files = list
        ;(this.onchange as () => Promise<void>)?.()
      },
    }
    const spy = jest
      .spyOn(document, "createElement")
      .mockReturnValueOnce(fakeInput as unknown as HTMLElement)
    const out = await pickAndReadFiles({
      multiple: true,
      filters: [{ name: "MD", extensions: ["md", "markdown"] }],
    })
    expect(fakeInput.accept).toBe(".md,.markdown")
    expect(out).toEqual([{ name: "a.txt", path: "", content: "AAA" }])
    spy.mockRestore()
  })
})

describe("pickAndReadBinaryFiles — Tauri branch", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("returns [] when the user cancels", async () => {
    mockOpen.mockResolvedValue(null)
    const out = await pickAndReadBinaryFiles()
    expect(out).toEqual([])
  })

  it("reads single picked file via the Tauri fs plugin", async () => {
    mockOpen.mockResolvedValue("/abs/path/skill.zip")
    mockReadBinary.mockResolvedValue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    const out = await pickAndReadBinaryFiles({
      filters: [{ name: "Zip", extensions: ["zip"] }],
    })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("skill.zip")
    expect(out[0].path).toBe("/abs/path/skill.zip")
    expect(Array.from(out[0].bytes)).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    })
  })

  it("reads multiple picked files and silently skips errored reads", async () => {
    mockOpen.mockResolvedValue(["/a.zip", "/b.zip"])
    mockReadBinary
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockRejectedValueOnce(new Error("nope"))
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const out = await pickAndReadBinaryFiles({ multiple: true })
    expect(out).toHaveLength(1)
    expect(Array.from(out[0].bytes)).toEqual([1])
    consoleSpy.mockRestore()
  })
})

describe("pickAndReadBinaryFiles — browser branch", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(false))

  it("returns [] on cancel", async () => {
    const fakeInput = {
      type: "",
      multiple: false,
      accept: "",
      files: null as FileList | null,
      onchange: null as null | (() => Promise<void>),
      oncancel: null as null | (() => void),
      click() {
        this.oncancel?.()
      },
    }
    const spy = jest
      .spyOn(document, "createElement")
      .mockReturnValueOnce(fakeInput as unknown as HTMLElement)
    const out = await pickAndReadBinaryFiles()
    expect(out).toEqual([])
    spy.mockRestore()
  })

  it("reads file bytes via File.arrayBuffer()", async () => {
    const fakeFile = {
      name: "bundle.zip",
      arrayBuffer: jest.fn(async () => new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer),
    }
    const fakeInput: {
      type: string
      multiple: boolean
      accept: string
      files: FileList | null
      onchange: null | (() => Promise<void>)
      oncancel: null | (() => void)
      click(): void
    } = {
      type: "",
      multiple: true,
      accept: "",
      files: null,
      onchange: null,
      oncancel: null,
      click() {
        const list = [fakeFile] as unknown as FileList
        Object.assign(list, { length: 1 })
        this.files = list
        ;(this.onchange as () => Promise<void>)?.()
      },
    }
    const spy = jest
      .spyOn(document, "createElement")
      .mockReturnValueOnce(fakeInput as unknown as HTMLElement)
    const out = await pickAndReadBinaryFiles({
      multiple: true,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    })
    expect(fakeInput.accept).toBe(".zip")
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("bundle.zip")
    expect(Array.from(out[0].bytes)).toEqual([0xde, 0xad, 0xbe, 0xef])
    spy.mockRestore()
  })
})

describe("saveFileAs — Tauri branch", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("returns false when the user cancels the save dialog", async () => {
    mockedDefaultExportDir.mockResolvedValue("/exp")
    mockSave.mockResolvedValue(null)
    const ok = await saveFileAs({ defaultName: "x.md", content: "c" })
    expect(ok).toBe(false)
    expect(mockedWrite).not.toHaveBeenCalled()
  })

  it("uses defaultExportDir when available", async () => {
    mockedDefaultExportDir.mockResolvedValue("/exp")
    mockSave.mockResolvedValue("/exp/x.md")
    mockedWrite.mockResolvedValue(undefined)
    const ok = await saveFileAs({ defaultName: "x.md", content: "C" })
    expect(ok).toBe(true)
    expect(mockSave).toHaveBeenCalledWith({ defaultPath: "/exp/x.md", filters: undefined })
    expect(mockedWrite).toHaveBeenCalledWith("/exp/x.md", "C")
  })

  it("falls back to bare default name when defaultExportDir throws", async () => {
    mockedDefaultExportDir.mockRejectedValue(new Error("nope"))
    mockSave.mockResolvedValue("/somewhere/x.md")
    mockedWrite.mockResolvedValue(undefined)
    const ok = await saveFileAs({ defaultName: "x.md", content: "C" })
    expect(ok).toBe(true)
    expect(mockSave).toHaveBeenCalledWith({ defaultPath: "x.md", filters: undefined })
  })
})

describe("saveFileAs — browser branch", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(false))

  it("creates a download anchor and revokes the URL", async () => {
    const click = jest.fn()
    const anchor = {
      href: "",
      download: "",
      click,
    }
    const createElementSpy = jest
      .spyOn(document, "createElement")
      .mockReturnValueOnce(anchor as unknown as HTMLElement)
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    const createObjectSpy = jest.fn(() => "blob:mock")
    const revokeSpy = jest.fn()
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = createObjectSpy
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = revokeSpy

    const ok = await saveFileAs({ defaultName: "out.txt", content: "hello" })
    expect(ok).toBe(true)
    expect(anchor.href).toBe("blob:mock")
    expect(anchor.download).toBe("out.txt")
    expect(click).toHaveBeenCalled()

    // Wait the setTimeout(…, 0)
    await new Promise((r) => setTimeout(r, 1))
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock")

    createElementSpy.mockRestore()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })
})

describe("pickDirectory", () => {
  it("returns null when not in Tauri", async () => {
    mockedIsTauri.mockReturnValue(false)
    expect(await pickDirectory()).toBeNull()
  })

  it("returns the picked directory in Tauri", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue("/tmp/pick")
    expect(await pickDirectory()).toBe("/tmp/pick")
  })

  it("returns null when user cancels", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue(null)
    expect(await pickDirectory()).toBeNull()
  })

  it("returns first when an array is returned", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue(["/x"])
    expect(await pickDirectory()).toBe("/x")
  })

  it("returns null when an empty array is returned", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockOpen.mockResolvedValue([])
    expect(await pickDirectory()).toBeNull()
  })
})

describe("saveFilesToDir", () => {
  it("writes each file via the confined command in Tauri, scoped to the picked dir", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedWriteConfined.mockResolvedValue(undefined)
    const result = await saveFilesToDir("/dst", [
      { name: "a.txt", content: "A" },
      { name: "b.txt", content: "B" },
    ])
    expect(result.writtenCount).toBe(2)
    expect(result.errored).toEqual([])
    expect(mockedWriteConfined).toHaveBeenNthCalledWith(1, "/dst/a.txt", "A", ["/dst"])
    expect(mockedWriteConfined).toHaveBeenNthCalledWith(2, "/dst/b.txt", "B", ["/dst"])
    expect(mockedWrite).not.toHaveBeenCalled()
  })

  it("captures per-file write errors in Tauri", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedWriteConfined.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined)
    const result = await saveFilesToDir("/dst", [
      { name: "a.txt", content: "A" },
      { name: "b.txt", content: "B" },
    ])
    expect(result.writtenCount).toBe(1)
    expect(result.errored).toEqual([{ name: "a.txt", error: "boom" }])
  })

  it("stringifies non-Error rejections", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedWriteConfined.mockRejectedValueOnce("plain")
    const result = await saveFilesToDir("/dst", [{ name: "a.txt", content: "A" }])
    expect(result.errored).toEqual([{ name: "a.txt", error: "plain" }])
  })

  it("falls back to per-file saveFileAs when not Tauri", async () => {
    mockedIsTauri.mockReturnValue(false)
    const click = jest.fn()
    const createSpy = jest
      .spyOn(document, "createElement")
      .mockImplementation(() => ({ href: "", download: "", click }) as unknown as HTMLElement)
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock"
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined

    const result = await saveFilesToDir(null, [
      { name: "a.txt", content: "A" },
      { name: "b.txt", content: "B" },
    ])
    expect(result.writtenCount).toBe(2)
    expect(click).toHaveBeenCalledTimes(2)
    createSpy.mockRestore()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it("falls back to per-file saveFileAs when in Tauri but dir is null", async () => {
    mockedIsTauri.mockReturnValue(true)
    const click = jest.fn()
    const createSpy = jest
      .spyOn(document, "createElement")
      .mockImplementation(() => ({ href: "", download: "", click }) as unknown as HTMLElement)
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock"
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined

    const result = await saveFilesToDir(null, [{ name: "a.txt", content: "A" }])
    expect(result.writtenCount).toBe(1)
    createSpy.mockRestore()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it("captures errors in browser fallback", async () => {
    mockedIsTauri.mockReturnValue(false)
    const createSpy = jest.spyOn(document, "createElement").mockImplementation(
      () =>
        ({
          href: "",
          download: "",
          click: () => {
            throw new Error("click fail")
          },
        }) as unknown as HTMLElement
    )
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock"
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined

    const result = await saveFilesToDir(null, [{ name: "a.txt", content: "A" }])
    expect(result.errored).toEqual([{ name: "a.txt", error: "click fail" }])
    createSpy.mockRestore()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it("captures non-Error errors in browser fallback", async () => {
    mockedIsTauri.mockReturnValue(false)
    const createSpy = jest.spyOn(document, "createElement").mockImplementation(
      () =>
        ({
          href: "",
          download: "",
          click: () => {
            throw "string-err"
          },
        }) as unknown as HTMLElement
    )
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock"
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined

    const result = await saveFilesToDir(null, [{ name: "a.txt", content: "A" }])
    expect(result.errored).toEqual([{ name: "a.txt", error: "string-err" }])
    createSpy.mockRestore()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })
})
