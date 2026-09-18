/** @jest-environment node */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"

import {
  clipboardImageCommand,
  clipboardImageProbeCommand,
  hasClipboardImage,
  imageWritesToStdout,
  probeOutputHasImage,
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
      on: () => {},
      end: (done?: () => void) => done?.(),
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
    const sink = { write: () => true, on: () => {}, end: (done?: () => void) => done?.() }
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

const nativeMac = process.platform === "darwin" ? describe : describe.skip
nativeMac("native macOS clipboard image formats", () => {
  it.each(["public.png", "public.tiff", "public.jpeg", "public.file-url"])(
    "converts %s on an isolated pasteboard",
    (type) => {
      const dir = mkdtempSync(join(tmpdir(), "cognia-clipboard-native-"))
      const output = join(dir, "output ' image.png")
      const name = `cognia-test-${process.pid}-${Date.now()}-${type}`
      const command = clipboardImageCommand("darwin", output)!
      const fixture = `ObjC.import('AppKit');
      const board=$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)});
      const data=$.NSData.alloc.initWithBase64EncodedStringOptions('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',0);
      const image=$.NSImage.alloc.initWithData(data);
      const kind=${JSON.stringify(type)};
      board.clearContents;
      if(kind==='public.file-url') {
        data.writeToFileAtomically(${JSON.stringify(join(dir, "source.png"))},true);
        board.writeObjects($.NSArray.arrayWithObject($.NSURL.fileURLWithPath(${JSON.stringify(join(dir, "source.png"))})));
        const icon=$.NSWorkspace.sharedWorkspace.iconForFile(${JSON.stringify(join(dir, "source.png"))});
        board.setDataForType(icon.TIFFRepresentation,'public.tiff');
      } else {
        const value=kind==='public.png'?data:kind==='public.tiff'?image.TIFFRepresentation:$.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation).representationUsingTypeProperties($.NSJPEGFileType,{});
        board.setDataForType(value,kind);
      }`
      try {
        execFileSync("osascript", ["-l", "JavaScript", "-e", fixture], { timeout: 10000 })
        execFileSync(command.cmd, [...command.args, name], { timeout: 10000 })
        const png = readFileSync(output)
        expect(png.readUInt32BE(16)).toBe(2)
        expect(png.readUInt32BE(20)).toBe(2)
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      } finally {
        execFileSync(
          "osascript",
          [
            "-l",
            "JavaScript",
            "-e",
            `ObjC.import('AppKit');$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}).releaseGlobally;`,
          ],
          { timeout: 10000 }
        )
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

it("selects wl-paste for Wayland and xclip for X11", () => {
  expect(
    clipboardImageCommand("linux", "/tmp/out.png", {
      WAYLAND_DISPLAY: "wayland-0",
      NODE_ENV: "test",
    })?.cmd
  ).toBe("wl-paste")
  expect(clipboardImageCommand("linux", "/tmp/out.png", { NODE_ENV: "test" })?.cmd).toBe("xclip")
})
it("waits for the streamed PNG to finish before checking the file", async () => {
  let finish: (() => void) | undefined
  const fileReady = jest.fn(() => true)
  const { spawn } = fakeSpawn({ code: 0, stdoutChunks: [Buffer.from("png")] })
  const result = readClipboardImage({
    platform: "linux",
    spawn,
    fileReady,
    createWriteStream: () =>
      ({
        write: () => true,
        on: () => {},
        end: (done: () => void) => {
          finish = done
        },
      }) as unknown as NodeJS.WritableStream,
  })
  await Promise.resolve()
  expect(fileReady).not.toHaveBeenCalled()
  finish?.()
  expect(await result).not.toBeNull()
  expect(fileReady).toHaveBeenCalledTimes(1)
})

describe("clipboardImageProbeCommand", () => {
  it("uses powershell ContainsImage on win32", () => {
    const c = clipboardImageProbeCommand("win32")
    expect(c?.cmd.toLowerCase()).toContain("powershell")
    expect(c?.args.join(" ")).toContain("ContainsImage")
    // The probe writes nothing to disk — only a 1/0 answer on stdout.
    expect(c?.args.join(" ")).not.toContain(".Save(")
  })
  it("uses osascript pasteboard types on darwin", () => {
    const c = clipboardImageProbeCommand("darwin")
    expect(c?.cmd).toBe("osascript")
    expect(c?.args.join(" ")).toContain("generalPasteboard")
  })
  it("lists advertised types on linux (wl-paste on Wayland, xclip on X11)", () => {
    const wayland = { WAYLAND_DISPLAY: "wayland-0" } as unknown as NodeJS.ProcessEnv
    const x11 = {} as unknown as NodeJS.ProcessEnv
    expect(clipboardImageProbeCommand("linux", wayland)).toEqual({
      cmd: "wl-paste",
      args: ["--list-types"],
    })
    expect(clipboardImageProbeCommand("linux", x11)?.cmd).toBe("xclip")
    expect(clipboardImageProbeCommand("linux", x11)?.args).toContain("TARGETS")
  })
  it("returns null on unsupported platforms", () => {
    expect(clipboardImageProbeCommand("freebsd" as NodeJS.Platform)).toBeNull()
  })
})

describe("probeOutputHasImage", () => {
  it("linux: true when the advertised list contains an image MIME type", () => {
    expect(probeOutputHasImage("linux", "TIMESTAMP\nTARGETS\nimage/png\nUTF8_STRING\n")).toBe(true)
    expect(probeOutputHasImage("linux", "image/jpeg")).toBe(true)
  })
  it("linux: false for text-only clipboards (substring inside a type does not count)", () => {
    expect(probeOutputHasImage("linux", "UTF8_STRING\ntext/plain;charset=utf-8")).toBe(false)
  })
  it("win32/darwin: only the literal 1 counts", () => {
    expect(probeOutputHasImage("win32", "1")).toBe(true)
    expect(probeOutputHasImage("darwin", "1\n")).toBe(true)
    expect(probeOutputHasImage("win32", "0")).toBe(false)
    expect(probeOutputHasImage("darwin", "")).toBe(false)
  })
})

describe("hasClipboardImage", () => {
  it("returns false on unsupported platforms without spawning", async () => {
    const spawn = jest.fn()
    await expect(
      hasClipboardImage({ platform: "freebsd" as NodeJS.Platform, spawn })
    ).resolves.toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })
  it("linux: true when the helper lists an image type", async () => {
    const { spawn } = fakeSpawn({ code: 0, stdoutChunks: [Buffer.from("image/png\n")] })
    await expect(hasClipboardImage({ platform: "linux", spawn })).resolves.toBe(true)
  })
  it("win32: false when the clipboard holds no image", async () => {
    const { spawn } = fakeSpawn({ code: 0, stdoutChunks: [Buffer.from("0")] })
    await expect(hasClipboardImage({ platform: "win32", spawn })).resolves.toBe(false)
  })
  it("returns false on non-zero exit even when stdout says 1", async () => {
    const { spawn } = fakeSpawn({ code: 1, stdoutChunks: [Buffer.from("1")] })
    await expect(hasClipboardImage({ platform: "win32", spawn })).resolves.toBe(false)
  })
  it("returns false when the helper is missing (spawn error)", async () => {
    const { spawn } = fakeSpawn({ code: 0, error: new Error("ENOENT") })
    await expect(hasClipboardImage({ platform: "linux", spawn })).resolves.toBe(false)
  })
  it("returns false when spawn throws synchronously", async () => {
    const spawn = (() => {
      throw new Error("boom")
    }) as unknown as NonNullable<ReadClipboardImageOpts["spawn"]>
    await expect(hasClipboardImage({ platform: "win32", spawn })).resolves.toBe(false)
  })
})

const nativeMacProbe = process.platform === "darwin" ? describe : describe.skip
nativeMacProbe("native macOS clipboard image probe", () => {
  it("reports 1 for an image pasteboard and 0 for an empty one", () => {
    const name = `cognia-probe-${process.pid}-${Date.now()}`
    const command = clipboardImageProbeCommand("darwin")!
    const seed = `ObjC.import('AppKit');
      const board=$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)});
      const data=$.NSData.alloc.initWithBase64EncodedStringOptions('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',0);
      board.clearContents;
      board.setDataForType(data,'public.png');`
    try {
      execFileSync("osascript", ["-l", "JavaScript", "-e", seed], { timeout: 10000 })
      const yes = execFileSync(command.cmd, [...command.args, name], {
        timeout: 10000,
        encoding: "utf8",
      })
      expect(yes.trim()).toBe("1")
      execFileSync(
        "osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('AppKit');$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}).clearContents;`,
        ],
        { timeout: 10000 }
      )
      const no = execFileSync(command.cmd, [...command.args, name], {
        timeout: 10000,
        encoding: "utf8",
      })
      expect(no.trim()).toBe("0")
    } finally {
      execFileSync(
        "osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('AppKit');$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}).releaseGlobally;`,
        ],
        { timeout: 10000 }
      )
    }
  })
})
