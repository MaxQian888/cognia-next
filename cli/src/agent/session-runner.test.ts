/**
 * @jest-environment node
 */
import { createAgentSession } from "./session-runner"
import { createPermissionGate } from "./permission-gate"
import { readTranscript, type TranscriptFs } from "./transcript"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { SidecarBootstrap } from "../runtime/bootstrap"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

const HOME = "/home/u/.cognia"

function cfg(): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: { anthropic: { apiKey: "sk" } },
    cwd: "/work",
    model: "claude-x",
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

function result(text: string): RunAndCaptureResult {
  return { text, messageId: "m", a2uiSurfaces: {}, a2uiSurfaceOrder: [] }
}

describe("createAgentSession", () => {
  it("bootstraps once and reuses options + session across sends", async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined)
    const boot = { transport: {} as never, shutdown } as unknown as SidecarBootstrap
    const bootstrap = jest.fn().mockResolvedValue(boot)
    const resolveOptions = jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" })
    const capture = jest
      .fn()
      .mockResolvedValueOnce(result("first"))
      .mockResolvedValueOnce(result("second"))

    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_persist",
      home: HOME,
      now: () => 1000,
      bootstrap,
      resolveOptions,
      capture,
      transcriptFs: memFs().fsx,
    })

    const r1 = await session.send("hello", { gate: createPermissionGate({ yes: true }) })
    const r2 = await session.send("again", { gate: createPermissionGate({ yes: true }) })

    expect(r1.text).toBe("first")
    expect(r2.text).toBe("second")
    // bootstrap + resolveOptions happen exactly once across both turns.
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(resolveOptions).toHaveBeenCalledTimes(1)
    // both turns reuse the same session id.
    expect(capture.mock.calls[0][0]).toBe("s_persist")
    expect(capture.mock.calls[1][0]).toBe("s_persist")
  })

  it("appends user + assistant turns to the transcript", async () => {
    const m = memFs()
    const boot = { transport: {} as never, shutdown: jest.fn() } as unknown as SidecarBootstrap
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s1",
      home: HOME,
      now: () => 1,
      bootstrap: async () => boot,
      resolveOptions: async () => ({ provider: "anthropic" }) as never,
      capture: async () => result("ok"),
      transcriptFs: m.fsx,
    })
    await session.send("q1", { gate: createPermissionGate({ yes: true }) })
    const entries = readTranscript(HOME, "s1", m.fsx)
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"])
  })

  it("close shuts down the sidecar and blocks further sends", async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined)
    const boot = { transport: {} as never, shutdown } as unknown as SidecarBootstrap
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s1",
      home: HOME,
      bootstrap: async () => boot,
      resolveOptions: async () => ({}) as never,
      capture: async () => result("x"),
      transcriptFs: memFs().fsx,
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    await session.close()
    await session.close() // idempotent
    expect(shutdown).toHaveBeenCalledTimes(1)
    await expect(
      session.send("more", { gate: createPermissionGate({ yes: true }) })
    ).rejects.toThrow(/closed/)
  })

  it("never bootstraps if no send happens", async () => {
    const bootstrap = jest.fn()
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      bootstrap,
      transcriptFs: memFs().fsx,
    })
    await session.close()
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it("mints a session id when none is given", () => {
    const session = createAgentSession({ config: cfg(), home: HOME, transcriptFs: memFs().fsx })
    expect(session.sessionId).toMatch(/^s_/)
  })
})
