import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { main, parseArgs } from "./cli"
import { ConfigError } from "./config"
import { memoryLogger } from "./logger"

describe("parseArgs", () => {
  it("parses the run and mirror commands", () => {
    expect(parseArgs(["run", "--config", "/etc/p.json"])).toEqual({
      command: "run",
      configFile: "/etc/p.json",
    })
    expect(parseArgs(["mirror", "--config=/etc/m.json"])).toEqual({
      command: "mirror",
      configFile: "/etc/m.json",
    })
    expect(parseArgs(["run", "-c", "/x.json"]).configFile).toBe("/x.json")
    expect(parseArgs(["--version"]).command).toBe("version")
    expect(parseArgs([]).command).toBe("help")
  })

  it("rejects unknown commands, unknown flags and a missing config", () => {
    expect(() => parseArgs(["serve"])).toThrow(ConfigError)
    expect(() => parseArgs(["run", "--verbose"])).toThrow(/unknown argument/)
    expect(() => parseArgs(["run"])).toThrow(/--config/)
    expect(() => parseArgs(["run", "--config"])).toThrow(/--config/)
  })
})

describe("main", () => {
  it("exits 2 on a configuration error without echoing file content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "probe-cli-"))
    const file = path.join(dir, "config.json")
    await writeFile(
      file,
      JSON.stringify({ apiBase: "http://insecure.example/api", secret: "do-not-print" })
    )
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = memoryLogger()
    try {
      expect(await main(["run", "--config", file], logger)).toBe(2)
    } finally {
      stderr.mockRestore()
    }
    expect(JSON.stringify(logger.lines)).not.toContain("do-not-print")
    expect(logger.lines.at(-1)).toMatchObject({ event: "config_error" })
  })

  it("prints the version", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      expect(await main(["--version"], memoryLogger())).toBe(0)
      expect(stdout).toHaveBeenCalledWith("dev\n")
    } finally {
      stdout.mockRestore()
    }
  })
})
