import { EventEmitter } from "node:events"

import {
  clipboardImageCommand,
  imageWritesToStdout,
  readClipboardImage,
  type ReadClipboardImageOpts,
} from "./clipboard-image"

describe("clipboardImageCommand", () => {
  it("uses powershell on win32", () => {
    const c = clipboardImageCommand("win32", "C:/tmp/c.png")
    expect(c?.cmd.toLowerCase()).toContain("powershell")
    expect(c?.args.join(" ")).toMatch(/Clipboard/i)
  })
  it("embeds the out path in the win32 command", () => {
    const c = clipboardImageCommand("win32", "C:/tmp/abc.png")
    expect(c?.args.join(" ")).toContain("C:/tmp/abc.png")
  })
  it("uses xclip image target on linux", () => {
    const c = clipboardImageCommand("linux", "/tmp/c.png")
    expect(c?.args.join(" ")).toMatch(/image\/png/)
    expect(c?.cmd).toBe("xclip")
  })
  it("uses an image read on darwin", () => {
    const c = clipboardImageCommand("darwin", "/tmp/c.png")
    expect(c).not.toBeNull()
    expect(c?.cmd).toBe("osascript")
    expect(c?.args.join(" ")).toContain("/tmp/c.png")
  })
  it("returns null on unsupported platform", () => {
    expect(clipboardImageCommand("freebsd" as NodeJS.Platform, "/tmp/c.png")).toBeNull()
  })
})

describe("imageWritesToStdout", () => {
  it("is true only for linux", () => {
    expect(imageWritesToStdout("linux")).toBe(true)
    expect(imageWritesToStdout("win32")).toBe(false)
    expect(imageWritesToStdout("darwin")).toBe(false)
  })
})

/** A fake child process whose lifecycle the test drives synchronously. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): void {
    this.killed = true
  }
}

/**
 * Build an injected spawn that returns a FakeChild and lets the test schedule
 * stdout chunks + the close code on the next tick (so the Promise's listeners
 * are attached first).
 */
function fakeSpawn(opts: { code: number; stdoutChunks?: Buffer[]; error?: Error }): {
  spawn: NonNullable<ReadClipboardImageOpts["spawn"]>
  child: FakeChild
} {
  const child = new FakeChild()
  const spawn = (() => {
    queueMicrotask(() => {
      if (opts.error) {
        child.emit("error", opts.error)
        return
      }
      for (const chunk of opts.stdoutChunks ?? []) child.stdout.emit("data", chunk)
      child.emit("close", opts.code)
    })
    return child
  }) as unknown as NonNullable<ReadClipboardImageOpts["spawn"]>
  return { spawn, child }
}

describe("readClipboardImage", () => {
  it("returns null on unsupported platform", async () => {
    const result = await readClipboardImage({
      platform: "freebsd" as NodeJS.Platform,
    })
    expect(result).toBeNull()
  })

  it("file-writing platform: returns {path} when child exits 0 and file is ready", async () => {
    const { spawn } = fakeSpawn({ code: 0 })
    const result = await readClipboardImage({
      platform: "win32",
      spawn,
      outPath: "C:/tmp/out.png",
      fileReady: () => true,
    })
    expect(result).toEqual({ path: "C:/tmp/out.png" })
  })

  it("file-writing platform: returns null when child exits non-zero", async () => {
    const { spawn } = fakeSpawn({ code: 1 })
    const result = await readClipboardImage({
      platform: "win32",
      spawn,
      outPath: "C:/tmp/out.png",
      fileReady: () => true,
    })
    expect(result).toBeNull()
  })

  it("file-writing platform: returns null when exit 0 but no image (file missing/empty)", async () => {
    const { spawn } = fakeSpawn({ code: 0 })
    const result = await readClipboardImage({
      platform: "win32",
      spawn,
      outPath: "C:/tmp/out.png",
      fileReady: () => false,
    })
    expect(result).toBeNull()
  })

  it("returns null when the spawn errors (helper not installed)", async () => {
    const { spawn } = fakeSpawn({ code: 0, error: new Error("ENOENT") })
    const result = await readClipboardImage({
      platform: "win32",
      spawn,
      outPath: "C:/tmp/out.png",
      fileReady: () => true,
    })
    expect(result).toBeNull()
  })

  it("returns null when spawn throws synchronously", async () => {
    const spawn = (() => {
      throw new Error("boom")
    }) as unknown as NonNullable<ReadClipboardImageOpts["spawn"]>
    const result = await readClipboardImage({
      platform: "win32",
      spawn,
      outPath: "C:/tmp/out.png",
      fileReady: () => true,
    })
    expect(result).toBeNull()
  })

  it("linux (stdout): pipes child stdout to a write stream and returns {path} when non-empty", async () => {
    const written: Buffer[] = []
    const sink = {
      write: (chunk: Buffer) => {
        written.push(chunk)
        return true
      },
      end: () => {},
    }
    const { spawn } = fakeSpawn({
      code: 0,
      stdoutChunks: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    })
    const result = await readClipboardImage({
      platform: "linux",
      spawn,
      outPath: "/tmp/out.png",
      fileReady: () => true,
      createWriteStream: () => sink as unknown as NodeJS.WritableStream,
    })
    expect(result).toEqual({ path: "/tmp/out.png" })
    expect(Buffer.concat(written)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it("linux (stdout): returns null when stdout produced nothing", async () => {
    const sink = { write: () => true, end: () => {} }
    const { spawn } = fakeSpawn({ code: 0, stdoutChunks: [] })
    const result = await readClipboardImage({
      platform: "linux",
      spawn,
      outPath: "/tmp/out.png",
      fileReady: () => false,
      createWriteStream: () => sink as unknown as NodeJS.WritableStream,
    })
    expect(result).toBeNull()
  })

  it("uses the default temp outPath + default fileReady when none injected", async () => {
    // Exercises defaultOutPath() and defaultFileReady() (statSync on a path
    // that does not exist → caught → false → null). No real file is created.
    const { spawn } = fakeSpawn({ code: 0 })
    const result = await readClipboardImage({ platform: "win32", spawn })
    expect(result).toBeNull()
  })

  it("falls back to the OS temp dir when TMPDIR/TEMP/TMP are unset", async () => {
    const saved = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    }
    delete process.env.TMPDIR
    delete process.env.TEMP
    delete process.env.TMP
    try {
      const { spawn } = fakeSpawn({ code: 0 })
      const result = await readClipboardImage({ platform: "win32", spawn })
      expect(result).toBeNull()
    } finally {
      if (saved.TMPDIR !== undefined) process.env.TMPDIR = saved.TMPDIR
      if (saved.TEMP !== undefined) process.env.TEMP = saved.TEMP
      if (saved.TMP !== undefined) process.env.TMP = saved.TMP
    }
  })

  it("uses the real fs createWriteStream default on linux without crashing", async () => {
    // outPath under the temp dir; fileReady injected false so no assertion on
    // disk contents, but the default createWriteStream factory is exercised.
    const dir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp"
    const outPath = `${dir.replace(/[/\\]$/, "")}/cognia-clip-test-${Date.now()}.png`
    const { spawn } = fakeSpawn({ code: 0, stdoutChunks: [] })
    const result = await readClipboardImage({
      platform: "linux",
      spawn,
      outPath,
      fileReady: () => false,
    })
    expect(result).toBeNull()
  })
})
