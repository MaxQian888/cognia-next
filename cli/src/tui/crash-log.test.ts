import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createCrashLogger, crashLogPath, defaultCrashLogger, formatCrashRecord } from "./crash-log"

describe("crashLogPath", () => {
  it("nests under logs/crash.log within the home dir", () => {
    expect(crashLogPath("/home/.cognia").replace(/\\/g, "/")).toBe("/home/.cognia/logs/crash.log")
  })
})

describe("createCrashLogger", () => {
  it("appends a JSON record with an injected clock and error details", () => {
    const lines: Array<{ file: string; line: string }> = []
    const log = createCrashLogger({
      file: "/tmp/crash.log",
      append: (file, line) => lines.push({ file, line }),
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    })
    const err = new Error("boom")
    err.stack = "Error: boom\n  at x"
    log("render", err, "component stack")
    expect(lines).toHaveLength(1)
    expect(lines[0].file).toBe("/tmp/crash.log")
    const rec = JSON.parse(lines[0].line)
    expect(rec).toMatchObject({
      time: "2026-07-03T00:00:00.000Z",
      source: "render",
      message: "boom",
      stack: "Error: boom\n  at x",
      info: "component stack",
    })
  })

  it("coerces a non-Error value into a message", () => {
    const lines: string[] = []
    const log = createCrashLogger({
      file: "/tmp/c.log",
      append: (_f, line) => lines.push(line),
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    })
    log("uncaughtException", "just a string")
    expect(JSON.parse(lines[0]).message).toBe("just a string")
  })

  it("with the real fs sink, creates the dir and appends the record", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-crash-"))
    try {
      const file = path.join(dir, "nested", "crash.log")
      const log = createCrashLogger({ file })
      log("render", new Error("real boom"))
      const contents = fs.readFileSync(file, "utf8").trim()
      expect(JSON.parse(contents)).toMatchObject({ source: "render", message: "real boom" })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never throws when the append sink fails", () => {
    const log = createCrashLogger({
      file: "/nope",
      append: () => {
        throw new Error("disk full")
      },
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    })
    expect(() => log("render", new Error("x"))).not.toThrow()
  })
})

describe("defaultCrashLogger", () => {
  it("writes under <home>/logs/crash.log", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-home-"))
    try {
      defaultCrashLogger(home)("uncaughtException", new Error("home boom"))
      const contents = fs.readFileSync(crashLogPath(home), "utf8").trim()
      expect(JSON.parse(contents)).toMatchObject({
        source: "uncaughtException",
        message: "home boom",
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("formatCrashRecord", () => {
  it("serializes to a newline-terminated JSON line", () => {
    const line = formatCrashRecord({ time: "t", source: "s", message: "m" })
    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line)).toEqual({ time: "t", source: "s", message: "m" })
  })
})
