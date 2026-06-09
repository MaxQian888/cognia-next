/**
 * @jest-environment node
 */
import { runHeadlessTurn, mintSessionId } from "./run"
import { readTranscript, type TranscriptFs } from "./transcript"
import { createPermissionGate } from "./permission-gate"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { SidecarBootstrap } from "../runtime/bootstrap"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

const HOME = "/home/u/.cognia"

function cfg(p: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: { anthropic: { apiKey: "sk" } },
    cwd: "/work",
    model: "claude-x",
    ...p,
  }
}

function memFs() {
  const files = new Map<string, string>()
  const fsx: TranscriptFs = {
    append: (p, line) => files.set(p, (files.get(p) ?? "") + line),
    read: (p) => (files.has(p) ? files.get(p)! : null),
    mkdirp: () => undefined,
  }
  return { fsx, files }
}

function fakeBoot() {
  const shutdown = jest.fn().mockResolvedValue(undefined)
  const boot = { transport: {} as never, shutdown } as unknown as SidecarBootstrap
  return { boot, shutdown }
}

function captureResult(over: Partial<RunAndCaptureResult> = {}): RunAndCaptureResult {
  return {
    text: "the reply",
    messageId: "m1",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
    usage: { inputTokens: 3, outputTokens: 4 } as RunAndCaptureResult["usage"],
    sdkSessionId: "sdk-1",
    ...over,
  }
}

describe("mintSessionId", () => {
  it("uses the s_ prefix and is deterministic given inputs", () => {
    expect(mintSessionId(0, 0.5)).toMatch(/^s_/)
    expect(mintSessionId(1000, 0.5)).toBe(mintSessionId(1000, 0.5))
  })
})

describe("runHeadlessTurn", () => {
  it("resolves options, captures, persists transcript, and shuts down", async () => {
    const m = memFs()
    const fb = fakeBoot()
    const resolveOptions = jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" })
    const capture = jest.fn().mockResolvedValue(captureResult())

    const res = await runHeadlessTurn({
      config: cfg(),
      prompt: "do it",
      sessionId: "s_fixed",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      now: 1234,
      bootstrap: async () => fb.boot,
      resolveOptions,
      capture,
      transcriptFs: m.fsx,
    })

    expect(res).toEqual({
      sessionId: "s_fixed",
      text: "the reply",
      usage: { inputTokens: 3, outputTokens: 4 },
      sdkSessionId: "sdk-1",
    })
    // resolveOptions saw a CLI ctx with the anthropic provider.
    expect(resolveOptions.mock.calls[0][0].session.providerOverride).toBe("anthropic")
    // capture got the session id, prompt, resolved options + the gate.
    const [sid, prompt, opts, cap] = capture.mock.calls[0]
    expect(sid).toBe("s_fixed")
    expect(prompt).toBe("do it")
    expect(opts).toMatchObject({ model: "claude-x", provider: "anthropic" })
    expect(typeof cap.onPermissionRequest).toBe("function")
    // transcript holds the user + assistant turns.
    const entries = readTranscript(HOME, "s_fixed", m.fsx)
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"])
    expect(entries[1].content).toBe("the reply")
    expect(entries[1].meta).toMatchObject({ provider: "anthropic", sdkSessionId: "sdk-1" })
    expect(fb.shutdown).toHaveBeenCalledTimes(1)
  })

  it("mints a session id when none is provided", async () => {
    const fb = fakeBoot()
    const res = await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      now: 42,
      bootstrap: async () => fb.boot,
      resolveOptions: async () => ({}) as never,
      capture: async () => captureResult({ sdkSessionId: undefined, usage: undefined }),
      transcriptFs: memFs().fsx,
    })
    expect(res.sessionId).toMatch(/^s_/)
  })

  it("still shuts down the sidecar when capture throws", async () => {
    const fb = fakeBoot()
    await expect(
      runHeadlessTurn({
        config: cfg(),
        prompt: "x",
        sessionId: "s1",
        gate: createPermissionGate({ yes: true }),
        home: HOME,
        bootstrap: async () => fb.boot,
        resolveOptions: async () => ({}) as never,
        capture: async () => {
          throw new Error("turn failed")
        },
        transcriptFs: memFs().fsx,
      })
    ).rejects.toThrow("turn failed")
    expect(fb.shutdown).toHaveBeenCalledTimes(1)
  })
})
