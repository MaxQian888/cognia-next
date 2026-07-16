/**
 * @jest-environment node
 */
import {
  runCommand,
  runFlagsToOverrides,
  resolveOutputFormat,
  mergePrompt,
  MAX_STDIN_BYTES,
} from "./run-command"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

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

/** Base deps with stdin neutralized so the real `process.stdin` is never drained
 * (a non-TTY jest stdin would otherwise block the `for await` in defaultReadStdin). */
const noStdin = { readStdin: async () => "" }

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
      "--backend",
      "claude-code",
    ])
    expect(runFlagsToOverrides(a)).toEqual({
      model: "m",
      provider: "openai",
      allowedTools: ["write", "bash"],
      agentBackend: "claude-code",
    })
  })

  it("maps --plugin-tools to pluginTools:true (the in-tree plugin tool gate)", () => {
    expect(runFlagsToOverrides(parseArgv(["chat", "--plugin-tools"]))).toEqual({
      pluginTools: true,
    })
  })

  it("maps --max-turns onto the ai-sdk step budget (floored, ≥1)", () => {
    expect(runFlagsToOverrides(parseArgv(["run", "hi", "--max-turns", "8"]))).toMatchObject({
      aiSdkMaxSteps: 8,
    })
    // Non-numeric / <1 values are ignored rather than producing a bad budget.
    expect(runFlagsToOverrides(parseArgv(["run", "hi", "--max-turns", "0"]))).not.toHaveProperty(
      "aiSdkMaxSteps"
    )
  })

  it("maps --dev-plugins to devPlugins + pluginTools (dev implies the runtime)", () => {
    expect(runFlagsToOverrides(parseArgv(["chat", "--dev-plugins"]))).toEqual({
      devPlugins: true,
      pluginTools: true,
    })
  })

  it("maps --dev-plugins-dir to a dir + enables dev plugins", () => {
    expect(runFlagsToOverrides(parseArgv(["chat", "--dev-plugins-dir", "./plugins"]))).toEqual({
      devPluginsDir: "./plugins",
      devPlugins: true,
      pluginTools: true,
    })
  })
})

describe("resolveOutputFormat", () => {
  it("defaults to text", () => {
    expect(resolveOutputFormat(parseArgv(["run", "hi"]))).toBe("text")
  })
  it("maps --json to stream-json (back-compat)", () => {
    expect(resolveOutputFormat(parseArgv(["run", "hi", "--json"]))).toBe("stream-json")
  })
  it("honors --output-format", () => {
    expect(resolveOutputFormat(parseArgv(["run", "hi", "--output-format", "json"]))).toBe("json")
    expect(resolveOutputFormat(parseArgv(["run", "hi", "--output-format", "stream-json"]))).toBe(
      "stream-json"
    )
  })
  it("throws on an invalid format", () => {
    expect(() => resolveOutputFormat(parseArgv(["run", "hi", "--output-format", "yaml"]))).toThrow(
      /invalid --output-format/
    )
  })
})

describe("mergePrompt", () => {
  it("uses the arg prompt alone when no stdin", () => {
    expect(mergePrompt("fix bug", "")).toBe("fix bug")
  })
  it("uses stdin alone when no arg prompt", () => {
    expect(mergePrompt("", "piped context")).toBe("piped context")
  })
  it("appends stdin to the arg prompt as context", () => {
    expect(mergePrompt("summarize", "long text")).toBe("summarize\n\nlong text")
  })
})

describe("runCommand", () => {
  it("errors with exit 2 when no prompt is given", async () => {
    const s = sink()
    const code = await runCommand(parseArgv(["run"]), {
      out: s.out,
      loadConfig: () => cfg(),
      ...noStdin,
    })
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
      ...noStdin,
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
    await runCommand(parseArgv(["run", "hi"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
      ...noStdin,
    })
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
      ...noStdin,
    })
    expect(code).toBe(0)
    expect(s.jsonl[0]).toEqual({ type: "text-delta", delta: "x" })
    expect(s.jsonl[1]).toMatchObject({ type: "result", sessionId: "s1", text: "x" })
    expect(s.stdout).toHaveLength(0) // no raw text writes in json mode
  })

  it("emits ONLY the final result object with --output-format json (no event lines)", async () => {
    const s = sink()
    const run = jest.fn().mockImplementation(async (p) => {
      p.onEvent({ type: "text-delta", delta: "x" })
      return { sessionId: "s1", text: "buffered", usage: { totalTokens: 2 } }
    })
    const code = await runCommand(parseArgv(["run", "hi", "--output-format", "json"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
      ...noStdin,
    })
    expect(code).toBe(0)
    expect(s.jsonl).toHaveLength(1)
    expect(s.jsonl[0]).toMatchObject({ type: "result", text: "buffered" })
    expect(s.stdout).toHaveLength(0)
  })

  it("returns exit 2 on an invalid --output-format", async () => {
    const s = sink()
    const code = await runCommand(parseArgv(["run", "hi", "--output-format", "xml"]), {
      out: s.out,
      loadConfig: () => cfg(),
      ...noStdin,
    })
    expect(code).toBe(2)
    expect(s.stderr.join("")).toMatch(/invalid --output-format/)
  })

  it("reads a piped prompt from stdin when no positional prompt is given", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s1", text: "ok" })
    const code = await runCommand(parseArgv(["run"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
      readStdin: async () => "do the thing",
    })
    expect(code).toBe(0)
    expect(run.mock.calls[0][0].prompt).toBe("do the thing")
  })

  it("merges the positional prompt with piped stdin context", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s1", text: "ok" })
    await runCommand(parseArgv(["run", "summarize"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
      readStdin: async () => "FILE BODY",
    })
    expect(run.mock.calls[0][0].prompt).toBe("summarize\n\nFILE BODY")
  })

  it("honors a promptOverride from the -p shorthand", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s1", text: "ok" })
    await runCommand(parseArgv(["-p"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
      promptOverride: "shorthand prompt",
      readStdin: async () => "",
    })
    expect(run.mock.calls[0][0].prompt).toBe("shorthand prompt")
  })

  it("returns exit 2 when stdin reading fails (oversized input)", async () => {
    const s = sink()
    const code = await runCommand(parseArgv(["run"]), {
      out: s.out,
      loadConfig: () => cfg(),
      readStdin: async () => {
        throw new Error(`piped input exceeds ${MAX_STDIN_BYTES} bytes`)
      },
    })
    expect(code).toBe(2)
    expect(s.stderr.join("")).toMatch(/exceeds/)
  })

  it("forwards --max-turns to the headless turn", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s1", text: "x" })
    await runCommand(parseArgv(["run", "hi", "--max-turns", "5"]), {
      out: s.out,
      loadConfig: () => cfg(),
      run,
      ...noStdin,
    })
    expect(run.mock.calls[0][0].maxTurns).toBe(5)
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
      ...noStdin,
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
      ...noStdin,
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
      ...noStdin,
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
      ...noStdin,
    })
    expect(code).toBe(2)
    expect(s.stderr.join("")).toMatch(/config error: bad config/)
  })
})
