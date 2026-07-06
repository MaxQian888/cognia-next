/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { McpLogEntry } from "../state/types"
import {
  mcpLogFilePath,
  formatMcpLogFileLine,
  createMcpLogFileWriter,
  defaultMcpLogFileWriter,
  type McpLogFsOps,
} from "./mcp-log-file"

function entry(p: Partial<McpLogEntry>): McpLogEntry {
  return {
    id: p.id ?? "c1",
    ts: p.ts ?? 0,
    level: p.level ?? "info",
    source: p.source ?? "stderr",
    message: p.message ?? "hello",
    ...(p.server ? { server: p.server } : {}),
  }
}

/** An in-memory fs seam recording appends + rotations. */
function fakeFs() {
  const files = new Map<string, string>()
  const rotations: Array<[string, string]> = []
  let dirs = 0
  const ops: McpLogFsOps = {
    sizeOf: (file) => files.get(file)?.length ?? 0,
    append: (file, data) => files.set(file, (files.get(file) ?? "") + data),
    rotate: (file, rotated) => {
      rotations.push([file, rotated])
      files.set(rotated, files.get(file) ?? "")
      files.delete(file)
    },
    ensureDir: () => {
      dirs += 1
    },
  }
  return { ops, files, rotations, dirCalls: () => dirs }
}

describe("mcp-log-file — path + line format", () => {
  it("builds the log path under <home>/logs", () => {
    expect(mcpLogFilePath("/home/u/.cognia")).toContain("mcp.log")
    expect(mcpLogFilePath("/home/u/.cognia")).toContain("logs")
  })

  it("serializes an entry to a single JSON line (ISO time, no server key when absent)", () => {
    const line = formatMcpLogFileLine(entry({ ts: 0, level: "error", message: "boom" }))
    expect(line.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(line)
    expect(parsed).toMatchObject({ level: "error", source: "stderr", message: "boom" })
    expect(parsed.time).toMatch(/T.*Z$/)
    expect("server" in parsed).toBe(false)
    const withServer = JSON.parse(formatMcpLogFileLine(entry({ server: "github" })))
    expect(withServer.server).toBe("github")
  })
})

describe("mcp-log-file — writer", () => {
  it("appends each entry and ensures the dir once", () => {
    const fake = fakeFs()
    const write = createMcpLogFileWriter({ file: "/log/mcp.log", fsOps: fake.ops })
    write(entry({ message: "one" }))
    write(entry({ message: "two" }))
    const content = fake.files.get("/log/mcp.log") ?? ""
    expect(content.split("\n").filter(Boolean)).toHaveLength(2)
    expect(content).toContain("one")
    expect(content).toContain("two")
    expect(fake.dirCalls()).toBe(1) // ensureDir only once
  })

  it("rotates to mcp.log.1 when the file would exceed maxBytes", () => {
    const fake = fakeFs()
    // Size the ceiling to hold exactly two lines: the third write rotates once.
    const lineLen = formatMcpLogFileLine(entry({ message: "a".repeat(40) })).length
    const write = createMcpLogFileWriter({
      file: "/log/mcp.log",
      fsOps: fake.ops,
      maxBytes: lineLen * 2 + 5,
    })
    write(entry({ message: "a".repeat(40) }))
    write(entry({ message: "b".repeat(40) }))
    write(entry({ message: "c".repeat(40) }))
    expect(fake.rotations).toEqual([["/log/mcp.log", "/log/mcp.log.1"]])
    // After rotation the live file holds only the post-rotation line.
    expect(fake.files.get("/log/mcp.log")).toContain("c".repeat(40))
    expect(fake.files.get("/log/mcp.log")).not.toContain("a".repeat(40))
    // The rotated generation holds the pre-rotation lines.
    expect(fake.files.get("/log/mcp.log.1")).toContain("a".repeat(40))
    expect(fake.files.get("/log/mcp.log.1")).toContain("b".repeat(40))
  })

  it("rotates by UTF-8 byte size for multibyte content, not UTF-16 code units", () => {
    const fake = fakeFs()
    // Each 中 is 3 UTF-8 bytes but 1 UTF-16 code unit; with the old `line.length`
    // accounting the running size undercounts ~3× and the third write would NOT
    // rotate. The ceiling holds ~2 lines BY BYTES.
    const msg = "中".repeat(100)
    const byteLen = Buffer.byteLength(formatMcpLogFileLine(entry({ message: msg })), "utf8")
    const write = createMcpLogFileWriter({
      file: "/log/mcp.log",
      fsOps: fake.ops,
      maxBytes: byteLen * 2 + 5,
    })
    write(entry({ message: msg }))
    write(entry({ message: msg }))
    write(entry({ message: msg }))
    expect(fake.rotations).toEqual([["/log/mcp.log", "/log/mcp.log.1"]])
  })

  it("seeds the running size from an existing file (rotates without a fresh start)", () => {
    const fake = fakeFs()
    const lineLen = formatMcpLogFileLine(entry({ message: "trigger" })).length
    // Pre-seed just under a one-line ceiling so the very first write rotates.
    fake.files.set("/log/mcp.log", "x".repeat(lineLen))
    const write = createMcpLogFileWriter({
      file: "/log/mcp.log",
      fsOps: fake.ops,
      maxBytes: lineLen + 5,
    })
    write(entry({ message: "trigger" }))
    expect(fake.rotations).toHaveLength(1)
  })

  it("swallows fs errors (never throws)", () => {
    const throwing: McpLogFsOps = {
      sizeOf: () => 0,
      append: () => {
        throw new Error("EROFS")
      },
      rotate: () => undefined,
      ensureDir: () => undefined,
    }
    const write = createMcpLogFileWriter({ file: "/log/mcp.log", fsOps: throwing })
    expect(() => write(entry({}))).not.toThrow()
  })
})

describe("mcp-log-file — real filesystem", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-log-test-"))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("defaultMcpLogFileWriter creates <home>/logs/mcp.log and appends, then rotates", () => {
    const write = defaultMcpLogFileWriter(dir)
    write(entry({ message: "first line" }))
    const file = mcpLogFilePath(dir)
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toContain("first line")

    // A tiny-ceiling writer over the same file exercises the real rotate path.
    const small = createMcpLogFileWriter({ file, maxBytes: 40 })
    small(entry({ message: "second line, pushing past the tiny ceiling" }))
    expect(fs.existsSync(`${file}.1`)).toBe(true)
  })
})
