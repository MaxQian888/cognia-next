import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, openSync, writeSync, closeSync } from "node:fs"
import { promises as fsp } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  MAX_SESSION_FILE_BYTES,
  SessionReadLimitError,
  nodeSessionFs,
  nodeVendorRoots,
} from "./node-session-fs"

describe("nodeSessionFs", () => {
  let dir: string
  const fs = nodeSessionFs()

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cognia-fs-"))
    await fsp.writeFile(path.join(dir, "a.txt"), "hello", "utf8")
    await fsp.mkdir(path.join(dir, "sub"))
  })
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it("exists() reflects presence", async () => {
    expect(await fs.exists(path.join(dir, "a.txt"))).toBe(true)
    expect(await fs.exists(path.join(dir, "nope"))).toBe(false)
  })

  it("readDir() lists basenames", async () => {
    const names = await fs.readDir(dir)
    expect(names.sort()).toEqual(["a.txt", "sub"])
  })

  it("stat() reports size + isFile", async () => {
    const f = await fs.stat(path.join(dir, "a.txt"))
    expect(f.isFile).toBe(true)
    expect(f.size).toBe(5)
    const d = await fs.stat(path.join(dir, "sub"))
    expect(d.isFile).toBe(false)
  })

  it("readTextFile() returns contents", async () => {
    expect(await fs.readTextFile(path.join(dir, "a.txt"))).toBe("hello")
  })
})

describe("nodeVendorRoots", () => {
  it("honours the relocation env vars the CLI process can see", () => {
    const roots = nodeVendorRoots("/home/u", {
      CLAUDE_CONFIG_DIR: "/relocated/claude",
      CODEX_HOME: "/relocated/codex",
      XDG_DATA_HOME: "/xdg/data",
    })
    expect(roots.claudeConfigDir).toBe("/relocated/claude")
    expect(roots.codexHome).toBe("/relocated/codex")
    expect(roots.opencodeDataDir).toBe("/xdg/data/opencode")
  })

  it("falls back to the home-relative conventions with a bare env", () => {
    const roots = nodeVendorRoots("/home/u", {})
    expect(roots.claudeConfigDir).toBe("/home/u/.claude")
    expect(roots.codexHome).toBe("/home/u/.codex")
  })

  it("reads the real process env by default", () => {
    expect(nodeVendorRoots("/home/u").codexHome).toBe(
      process.env.CODEX_HOME?.trim() || "/home/u/.codex"
    )
  })
})

describe("bounded session reads", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bounded-sessions-"))
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it("rejects a large descriptor before read and leaves its file intact", async () => {
    const file = path.join(dir, "large.jsonl")
    const handle = await fsp.open(file, "w")
    await handle.truncate(MAX_SESSION_FILE_BYTES + 1)
    await handle.close()
    const onLimit = jest.fn()
    await expect(nodeSessionFs({ onLimit }).readTextFile(file)).rejects.toMatchObject({
      name: "SessionReadLimitError",
      reason: "file",
    })
    expect(onLimit).toHaveBeenCalledWith("file")
    expect((await fsp.stat(file)).size).toBe(MAX_SESSION_FILE_BYTES + 1)
  })

  it("decodes UTF-8 across read chunks and enforces aggregate bytes", async () => {
    const file = path.join(dir, "utf8.jsonl")
    const content = "a".repeat(65535) + "中"
    await fsp.writeFile(file, content)
    const reader = nodeSessionFs({ maxTotalBytes: Buffer.byteLength(content) })
    expect(await reader.readTextFile(file)).toBe(content)
    await expect(reader.readTextFile(file)).rejects.toMatchObject({ reason: "budget" })
    await fsp.writeFile(file, "")
    expect(await reader.readTextFile(file)).toBe("")
    await expect(reader.readTextFile(dir)).rejects.toThrow("not a regular file")
    await expect(reader.readTextFile(path.join(dir, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it.each([32, 64 * 1024 * 1024])(
    "allows many concurrent tiny files with a %i-byte budget",
    async (maxTotalBytes) => {
      const files = Array.from({ length: 32 }, (_, index) => path.join(dir, `${index}.jsonl`))
      await Promise.all(files.map((file) => fsp.writeFile(file, "a")))
      const onLimit = jest.fn()
      const reader = nodeSessionFs({ maxTotalBytes, onLimit })
      expect(await Promise.all(files.map((file) => reader.readTextFile(file)))).toEqual(
        files.map(() => "a")
      )
      expect(onLimit).not.toHaveBeenCalled()
      if (maxTotalBytes === 32)
        await expect(reader.readTextFile(files[0])).rejects.toMatchObject({ reason: "budget" })
    }
  )

  it("stops a growing file at the byte budget and closes its descriptor", async () => {
    const close = jest.fn()
    const read = jest.fn(async (buffer: Buffer) => {
      buffer.fill(97)
      return { bytesRead: buffer.length }
    })
    jest.spyOn(fsp, "open").mockResolvedValue({
      stat: async () => ({ size: 1, isFile: () => true }),
      read,
      close,
    } as unknown as Awaited<ReturnType<typeof fsp.open>>)
    await expect(nodeSessionFs({ maxTotalBytes: 4 }).readTextFile("growing")).rejects.toMatchObject(
      { reason: "budget" }
    )
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls.map(([buffer]) => buffer.length)).toEqual([1, 4])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("charges actual growth and refunds a file that shrinks after stat", async () => {
    const contents = ["abc", "", "d"]
    jest.spyOn(fsp, "open").mockImplementation(async () => {
      const content = Buffer.from(contents.shift()!)
      let offset = 0
      return {
        stat: async () => ({ size: 1, isFile: () => true }),
        read: async (buffer: Buffer) => {
          const bytesRead = content.copy(buffer, 0, offset, offset + buffer.length)
          offset += bytesRead
          return { bytesRead }
        },
        close: jest.fn(),
      } as unknown as Awaited<ReturnType<typeof fsp.open>>
    })
    const onLimit = jest.fn()
    const reader = nodeSessionFs({ maxTotalBytes: 4, onLimit })
    expect(await reader.readTextFile("growing")).toBe("abc")
    expect(await reader.readTextFile("shrinking")).toBe("")
    expect(await reader.readTextFile("last")).toBe("d")
    expect(onLimit).not.toHaveBeenCalled()
  })

  it("stops growth beyond the per-file ceiling even without an aggregate limit", async () => {
    const close = jest.fn()
    jest.spyOn(fsp, "open").mockResolvedValue({
      stat: async () => ({ size: MAX_SESSION_FILE_BYTES, isFile: () => true }),
      read: async (buffer: Buffer) => ({ bytesRead: buffer.length }),
      close,
    } as unknown as Awaited<ReturnType<typeof fsp.open>>)
    await expect(nodeSessionFs().readTextFile("growing")).rejects.toMatchObject({ reason: "file" })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("closes after read failures and handles concurrent budget reservations", async () => {
    const close = jest.fn()
    jest.spyOn(fsp, "open").mockResolvedValue({
      stat: async () => ({ size: 1, isFile: () => true }),
      read: async () => {
        throw new Error("read failed")
      },
      close,
    } as unknown as Awaited<ReturnType<typeof fsp.open>>)
    const reader = nodeSessionFs({ maxTotalBytes: 4 })
    const outcomes = await Promise.allSettled([
      reader.readTextFile("one"),
      reader.readTextFile("two"),
    ])
    expect(outcomes.every((result) => result.status === "rejected")).toBe(true)
    expect(close).toHaveBeenCalledTimes(2)
    expect(new SessionReadLimitError("budget").message).toContain("budget")
  })

  it("survives the real async-read/JSON-parser path under a 96 MiB child heap", () => {
    const buildDir = mkdtempSync(path.join(process.cwd(), "node_modules/.session-read-test-"))
    const file = path.join(dir, "rollout.jsonl")
    const fd = openSync(file, "w")
    const record = JSON.stringify({ text: "中", nested: [{ value: 1 }, 2, 3] })
    try {
      writeSync(fd, '{"type":"event_msg","payload":{"items":[')
      const chunk = (record + ",").repeat(1000)
      for (let i = 0; i < 500; i++) writeSync(fd, chunk)
      writeSync(fd, record + "]}}\n")
    } finally {
      closeSync(fd)
    }
    const outfile = path.join(buildDir, "child.mjs")
    try {
      const contents = `
        import {nodeSessionFs, SessionReadLimitError} from './cli/src/tui/runtime/node-session-fs';
        import {summarizeCodexFile} from './lib/session-import/adapters/codex';
        try {
          const raw = await nodeSessionFs().readTextFile(process.argv[2]);
          summarizeCodexFile(raw, process.argv[2]);
          process.exitCode = 2;
        } catch (error) {
          if (!(error instanceof SessionReadLimitError) || error.reason !== 'file') throw error;
          console.log('bounded-before-parse');
        }
      `
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {build} from 'esbuild';
        await build({stdin:{contents:${JSON.stringify(contents)},resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
      `,
        ],
        { timeout: 30000 }
      )
      const result = spawnSync(process.execPath, ["--max-old-space-size=96", outfile, file], {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      })
      expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
        status: 0,
        signal: null,
        stderr: "",
      })
      expect(result.stdout).toContain("bounded-before-parse")
    } finally {
      rmSync(buildDir, { recursive: true, force: true })
    }
  }, 30000)
})
