/**
 * @jest-environment node
 */
import { maybePushHandoff, handoffCommand, resumeCommand, handoffDropPath } from "./handoff-cmd"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import type { TranscriptEntry } from "../agent/transcript"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

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

describe("resumeCommand", () => {
  it("requires an id and a prompt", async () => {
    const s = sink()
    expect(await resumeCommand(parseArgv(["resume"]), { out: s.out, home: HOME })).toBe(2)
    expect(await resumeCommand(parseArgv(["resume", "s1"]), { out: s.out, home: HOME })).toBe(2)
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
