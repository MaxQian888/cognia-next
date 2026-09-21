/**
 * @jest-environment node
 */
import { maybePushHandoff, handoffCommand, resumeCommand, handoffDropPath } from "./handoff-cmd"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import type { TranscriptEntry } from "../agent/transcript"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

const HOME = "/home/u/.cognia"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const out: OutputSink = {
    write: (t) => stdout.push(t),
    error: (t) => stderr.push(t),
    json: () => undefined,
  }
  return { out, stdout: () => stdout.join(""), stderr: () => stderr.join("") }
}

function cfg(): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: {},
    cwd: "/work",
  }
}

const TRANSCRIPT: TranscriptEntry[] = [
  { ts: 1, role: "user", content: "fix it" },
  { ts: 2, role: "assistant", content: "done", meta: { provider: "anthropic", model: "claude-x" } },
]

describe("maybePushHandoff", () => {
  it("pushes the transcript when a desktop is reachable", async () => {
    const s = sink()
    const pushHandoff = jest.fn().mockResolvedValue({ ok: true, sessionId: "s1" })
    const ok = await maybePushHandoff("s1", "My run", {
      out: s.out,
      home: HOME,
      readTranscript: () => TRANSCRIPT,
      detectDesktop: async () => ({ baseUrl: "http://127.0.0.1:1", devToken: "t" }),
      pushHandoff,
    })
    expect(ok).toBe(true)
    expect(pushHandoff.mock.calls[0][1]).toMatchObject({
      sessionId: "s1",
      title: "My run",
      messages: [
        { role: "user", content: "fix it" },
        { role: "assistant", content: "done" },
      ],
      meta: { provider: "anthropic", model: "claude-x" },
    })
    expect(s.stdout()).toMatch(/Handed off session s1/)
  })

  it("returns false with a notice when no transcript exists", async () => {
    const s = sink()
    const ok = await maybePushHandoff("s1", undefined, {
      out: s.out,
      home: HOME,
      readTranscript: () => [],
    })
    expect(ok).toBe(false)
    expect(s.stderr()).toMatch(/no transcript/)
  })

  it("returns false with a notice when no desktop is running", async () => {
    const s = sink()
    const ok = await maybePushHandoff("s1", undefined, {
      out: s.out,
      home: HOME,
      readTranscript: () => TRANSCRIPT,
      detectDesktop: async () => null,
    })
    expect(ok).toBe(false)
    expect(s.stderr()).toMatch(/no running Cognia desktop/)
  })

  it("returns false when the push throws", async () => {
    const s = sink()
    const ok = await maybePushHandoff("s1", undefined, {
      out: s.out,
      home: HOME,
      readTranscript: () => TRANSCRIPT,
      detectDesktop: async () => ({ baseUrl: "http://x", devToken: "t" }),
      pushHandoff: async () => {
        throw new Error("HTTP 401")
      },
    })
    expect(ok).toBe(false)
    expect(s.stderr()).toMatch(/handoff failed: HTTP 401/)
  })
})

describe("handoffCommand", () => {
  it("requires a session id", async () => {
    const s = sink()
    expect(await handoffCommand(parseArgv(["handoff"]), { out: s.out, home: HOME })).toBe(2)
  })

  it("returns 0 when the push succeeds", async () => {
    const s = sink()
    const code = await handoffCommand(parseArgv(["handoff", "s1"]), {
      out: s.out,
      home: HOME,
      readTranscript: () => TRANSCRIPT,
      detectDesktop: async () => ({ baseUrl: "http://x", devToken: "t" }),
      pushHandoff: async () => ({ ok: true, sessionId: "s1" }),
    })
    expect(code).toBe(0)
  })
})

it("encodes imported ids consistently in handoff drop paths", () => {
  expect(handoffDropPath(HOME, "import:codex:id")).toBe(`${HOME}/handoff/import%3Acodex%3Aid.jsonl`)
})

describe("resumeCommand", () => {
  it("rejects oversized external handoffs when the backend cannot enforce tool-free summaries", async () => {
    const s = sink()
    const run = jest.fn()
    const write = jest.fn()
    const code = await resumeCommand(parseArgv(["resume", "large", "continue"]), {
      out: s.out,
      home: HOME,
      loadConfig: () => ({ ...cfg(), agentBackend: "codex" }),
      run,
      readDrop: () =>
        JSON.stringify({ ts: 1, role: "user", content: "Historical constraint. ".repeat(1500) }),
      transcriptFs: { read: () => null, mkdirp: jest.fn(), append: jest.fn(), write },
    })
    expect(code).toBe(2)
    expect(run).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(s.stderr()).toContain("cannot enforce tool-free summarization")
  })

  it("summarizes oversized history in isolated tool-free turns before continuing", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({
      sessionId: "summary",
      text: "Keep the acceptance constraints; validation remains pending.",
    })
    const code = await resumeCommand(parseArgv(["resume", "large", "continue"]), {
      out: s.out,
      home: HOME,
      loadConfig: () => cfg(),
      run,
      readDrop: () =>
        JSON.stringify({ ts: 1, role: "user", content: "Acceptance constraint. ".repeat(1500) }),
      transcriptFs: { read: () => null, mkdirp: jest.fn(), append: jest.fn(), write: jest.fn() },
    })
    expect(code).toBe(0)
    expect(run.mock.calls.length).toBeGreaterThan(1)
    const summary = run.mock.calls[0][0]
    expect(summary.sessionId).toBeUndefined()
    expect(summary.resolveOptions).toEqual(expect.any(Function))
    const continuation = run.mock.calls.at(-1)![0]
    expect(continuation.sessionId).toBe("large")
    expect(continuation.prompt).toContain("Keep the acceptance constraints")
  })

  it("does not continue or persist when an oversized history cannot be summarized", async () => {
    const s = sink()
    const write = jest.fn()
    const run = jest.fn().mockRejectedValue(new Error("provider unavailable"))
    const code = await resumeCommand(parseArgv(["resume", "large", "continue"]), {
      out: s.out,
      home: HOME,
      loadConfig: () => cfg(),
      run,
      readDrop: () =>
        JSON.stringify({ ts: 1, role: "user", content: "Historical constraint. ".repeat(1500) }),
      transcriptFs: { read: () => null, mkdirp: jest.fn(), append: jest.fn(), write },
    })
    expect(code).not.toBe(0)
    expect(write).not.toHaveBeenCalled()
    expect(run.mock.calls.every(([request]) => request.sessionId !== "large")).toBe(true)
    expect(s.stderr()).toContain("provider unavailable")
  })

  it("requires an id and rejects a missing non-interactive prompt", async () => {
    const s = sink()
    expect(await resumeCommand(parseArgv(["resume"]), { out: s.out, home: HOME })).toBe(2)
    expect(
      await resumeCommand(parseArgv(["resume", "s1"]), {
        out: s.out,
        home: HOME,
        readPrompt: async () => null,
      })
    ).toBe(2)
  })

  it("prompts for the next turn when resume is launched without an inline prompt", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s1", text: "continued" })
    const readPrompt = jest.fn().mockResolvedValue("inspect the remaining failures")
    const drop = JSON.stringify({ ts: 1, role: "assistant", content: "earlier context" }) + "\n"

    const code = await resumeCommand(parseArgv(["resume", "s1"]), {
      out: s.out,
      home: HOME,
      readDrop: () => drop,
      readPrompt,
      transcriptFs: { read: () => null, mkdirp: jest.fn(), append: jest.fn(), write: jest.fn() },
      loadConfig: () => cfg(),
      run,
    })

    expect(code).toBe(0)
    expect(readPrompt).toHaveBeenCalledWith("Continue session s1 › ")
    expect(run.mock.calls[0][0].prompt).toMatch(/inspect the remaining failures/)
  })

  it("retains structured source history for the CLI return path", async () => {
    const s = sink()
    const write = jest.fn()
    const run = jest.fn().mockResolvedValue({ sessionId: "rich", text: "continued" })
    const parts = [
      {
        type: "dynamic-tool",
        toolName: "test",
        toolCallId: "call",
        state: "output-available",
        input: {},
        output: "73 tests passed",
      },
    ]
    const drop = JSON.stringify({
      ts: 1,
      schemaVersion: 1,
      id: "source",
      role: "assistant",
      content: "tool evidence",
      parts,
    })
    const code = await resumeCommand(parseArgv(["resume", "rich", "continue"]), {
      out: s.out,
      home: HOME,
      readDrop: () => drop,
      loadConfig: () => cfg(),
      run,
      transcriptFs: { read: () => null, mkdirp: jest.fn(), append: jest.fn(), write },
    })
    expect(code).toBe(0)
    expect(JSON.parse(write.mock.calls[0][1])).toMatchObject({ id: "source", parts })
    expect(run.mock.calls[0][0].prompt).toContain("73 tests passed")
  })

  it("records only the new user input instead of recursively copying the handoff context", async () => {
    const s = sink()
    const append = jest.fn()
    const run = jest.fn().mockImplementation(async (params) => {
      params.transcriptFs.append(
        "/transcript",
        JSON.stringify({ ts: 2, role: "user", content: params.prompt }) + "\n"
      )
      return { sessionId: "new", text: "done" }
    })
    await resumeCommand(parseArgv(["resume", "new", "next step"]), {
      out: s.out,
      home: HOME,
      loadConfig: () => cfg(),
      run,
      readDrop: () => JSON.stringify({ ts: 1, role: "user", content: "original instructions" }),
      transcriptFs: { read: () => null, mkdirp: jest.fn(), append, write: jest.fn() },
    })
    expect(JSON.parse(append.mock.calls[0][1]).content).toBe("next step")
    expect(run.mock.calls[0][0].prompt).toContain("original instructions")
  })

  it("rejects malformed drop data without invoking the agent", async () => {
    const s = sink()
    const run = jest.fn()
    expect(
      await resumeCommand(parseArgv(["resume", "bad", "continue"]), {
        out: s.out,
        home: HOME,
        readDrop: () => '{"role":"assistant","content":12}',
        run,
      })
    ).toBe(2)
    expect(run).not.toHaveBeenCalled()
    expect(s.stderr()).toContain("invalid handoff transcript")
  })

  it("errors when no drop file exists", async () => {
    const s = sink()
    const code = await resumeCommand(parseArgv(["resume", "s1", "go on"]), {
      out: s.out,
      home: HOME,
      readDrop: () => null,
    })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/no handed-off session "s1"/)
  })

  it("re-injects the prior transcript as a preamble and runs a turn", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue({ sessionId: "s1", text: "continued" })
    const drop =
      JSON.stringify({ ts: 1, role: "user", content: "earlier q" }) +
      "\n" +
      JSON.stringify({ ts: 2, role: "assistant", content: "earlier a" }) +
      "\n"
    const code = await resumeCommand(parseArgv(["resume", "s1", "what next?", "--yes"]), {
      out: s.out,
      home: HOME,
      readDrop: (p) => (p === handoffDropPath(HOME, "s1") ? drop : null),
      transcriptFs: { read: () => null, mkdirp: jest.fn(), append: jest.fn(), write: jest.fn() },
      loadConfig: () => cfg(),
      run,
    })
    expect(code).toBe(0)
    const passed = run.mock.calls[0][0]
    expect(passed.sessionId).toBe("s1")
    expect(passed.prompt).toMatch(/earlier q/)
    expect(passed.prompt).toMatch(/earlier a/)
    expect(passed.prompt).toMatch(/what next\?/)
  })
})
