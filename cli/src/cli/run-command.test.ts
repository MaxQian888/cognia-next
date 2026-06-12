/**
 * @jest-environment node
 */
import { runCommand, runFlagsToOverrides } from "./run-command"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const jsonl: unknown[] = []
  const out: OutputSink = {
    write: (t) => stdout.push(t),
    error: (t) => stderr.push(t),
    json: (o) => jsonl.push(o),
  }
  return { out, stdout, stderr, jsonl, text: () => stdout.join("") }
}

function cfg(): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: {},
    cwd: "/work",
  }
}

describe("runFlagsToOverrides", () => {
  it("maps run flags into config overrides", () => {
    const a = parseArgv([
      "run",
      "hi",
      "--model",
      "m",
      "--provider",
      "openai",
      "--allow",
      "write, bash",
    ])
    expect(runFlagsToOverrides(a)).toEqual({
      model: "m",
      provider: "openai",
      allowedTools: ["write", "bash"],
    })
  })

  it("maps --plugin-tools to pluginTools:true (the in-tree plugin tool gate)", () => {
    expect(runFlagsToOverrides(parseArgv(["chat", "--plugin-tools"]))).toEqual({
      pluginTools: true,
    })
  })
})

describe("runCommand", () => {
  it("errors with exit 2 when no prompt is given", async () => {
    const s = sink()
    const code = await runCommand(parseArgv(["run"]), { out: s.out, loadConfig: () => cfg() })
    expect(code).toBe(2)
    expect(s.stderr.join("")).toMatch(/prompt is required/)
  })

  it("runs a turn and prints the reply text (non-json)", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s1", text: "done" })
    const code = await runCommand(parseArgv(["run", "do it", "--yes"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
    })
    expect(code).toBe(0)
    expect(s.text()).toBe("done\n")
    // gate passed to run approves everything (yes flag)
    const passed = run.mock.calls[0][0]
    expect(typeof passed.gate).toBe("function")
  })

  it("streams text-delta events and skips the final reprint", async () => {
    const s = sink()
    const run = jest.fn().mockImplementation(async (p) => {
      p.onEvent({ type: "text-delta", delta: "hel" })
      p.onEvent({ type: "text-delta", delta: "lo" })
      return { sessionId: "s1", text: "hello" }
    })
    await runCommand(parseArgv(["run", "hi"]), { out: s.out, loadConfig: () => cfg(), run })
    expect(s.text()).toBe("hello\n") // streamed "hel"+"lo" then newline, no double print
  })

  it("emits JSONL events + a final result with --json", async () => {
    const s = sink()
    const run = jest.fn().mockImplementation(async (p) => {
      p.onEvent({ type: "text-delta", delta: "x" })
      return { sessionId: "s1", text: "x", usage: { totalTokens: 1 }, sdkSessionId: "k" }
    })
    const code = await runCommand(parseArgv(["run", "hi", "--json"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
    })
    expect(code).toBe(0)
    expect(s.jsonl[0]).toEqual({ type: "text-delta", delta: "x" })
    expect(s.jsonl[1]).toMatchObject({ type: "result", sessionId: "s1", text: "x" })
    expect(s.stdout).toHaveLength(0) // no raw text writes in json mode
  })

  it("pushes a handoff after the turn when --handoff is set", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s_run", text: "done" })
    const pushHandoff = jest.fn().mockResolvedValue(true)
    const code = await runCommand(parseArgv(["run", "do it", "--yes", "--handoff"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
      pushHandoff,
    })
    expect(code).toBe(0)
    expect(pushHandoff).toHaveBeenCalledWith("s_run", "do it", { out: s.out })
  })

  it("does not push a handoff without --handoff", async () => {
    const s = sink()
    const pushHandoff = jest.fn()
    await runCommand(parseArgv(["run", "do it"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run: jest.fn().mockResolvedValue({ sessionId: "s1", text: "x" }),
      pushHandoff,
    })
    expect(pushHandoff).not.toHaveBeenCalled()
  })

  it("returns exit 1 and reports when the turn throws", async () => {
    const s = sink()
    const run = jest.fn().mockRejectedValue(new Error("boom"))
    const code = await runCommand(parseArgv(["run", "hi"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
    })
    expect(code).toBe(1)
    expect(s.stderr.join("")).toMatch(/run failed: boom/)
  })

  it("returns exit 2 on a config load error", async () => {
    const s = sink()
    const code = await runCommand(parseArgv(["run", "hi"]), {
      out: s.out,
      loadConfig: () => {
        throw new Error("bad config")
      },
    })
    expect(code).toBe(2)
    expect(s.stderr.join("")).toMatch(/config error: bad config/)
  })
})
