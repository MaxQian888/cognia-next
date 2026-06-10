/**
 * @jest-environment node
 */
import { interpretLine, chatCommand } from "./chat"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import type { AgentSession } from "../agent/session-runner"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

function cfg(): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: {},
    cwd: "/work",
  }
}

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

/** Scripted line reader: yields each line, then null (EOF). */
function scriptedReader(lines: string[]) {
  let i = 0
  return async () => (i < lines.length ? lines[i++] : null)
}

function fakeSessionFactory() {
  const sessions: Array<{ sessionId: string; send: jest.Mock; close: jest.Mock }> = []
  const factory = jest.fn(() => {
    const send = jest.fn(async (_prompt: string, opts: { onEvent?: (e: unknown) => void }) => {
      opts.onEvent?.({ type: "text-delta", delta: "reply" })
      return { text: "reply", messageId: "m", a2uiSurfaces: {}, a2uiSurfaceOrder: [] }
    })
    const s = { sessionId: `s_${sessions.length}`, send, close: jest.fn(async () => undefined) }
    sessions.push(s)
    return s as unknown as AgentSession
  })
  return { factory, sessions }
}

describe("interpretLine", () => {
  it.each([
    ["/exit", "exit"],
    ["/quit", "exit"],
    ["/clear", "clear"],
    ["/new", "clear"],
    ["/handoff", "handoff"],
    ["/help", "help"],
  ])("maps %s", (line, kind) => {
    expect(interpretLine(line).kind).toBe(kind)
  })
  it("treats plain text as send", () => {
    expect(interpretLine("fix the bug")).toEqual({ kind: "send", text: "fix the bug" })
  })
  it("treats blank as noop", () => {
    expect(interpretLine("   ").kind).toBe("noop")
  })
  it("flags an unknown slash command", () => {
    expect(interpretLine("/frob")).toEqual({ kind: "unknown", command: "frob" })
  })
})

describe("chatCommand", () => {
  const baseDeps = () => ({ loadConfig: () => cfg(), confirm: async () => true })

  it("sends a line as a turn and streams the reply", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    const code = await chatCommand(parseArgv(["chat"]), {
      ...baseDeps(),
      out: s.out,
      createSession: f.factory,
      readLine: scriptedReader(["hello", "/exit"]),
    })
    expect(code).toBe(0)
    expect(f.sessions[0].send).toHaveBeenCalledWith("hello", expect.any(Object))
    expect(s.stdout()).toMatch(/reply/)
    expect(f.sessions[0].close).toHaveBeenCalled()
  })

  it("/handoff pushes the current session", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    const pushHandoff = jest.fn().mockResolvedValue(true)
    await chatCommand(parseArgv(["chat"]), {
      ...baseDeps(),
      out: s.out,
      createSession: f.factory,
      pushHandoff,
      readLine: scriptedReader(["/handoff", "/exit"]),
    })
    expect(pushHandoff).toHaveBeenCalledWith("s_0", undefined, { out: s.out })
  })

  it("/clear starts a fresh session", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    await chatCommand(parseArgv(["chat"]), {
      ...baseDeps(),
      out: s.out,
      createSession: f.factory,
      readLine: scriptedReader(["/clear", "/exit"]),
    })
    expect(f.factory).toHaveBeenCalledTimes(2) // initial + after /clear
    expect(f.sessions[0].close).toHaveBeenCalled()
    expect(s.stdout()).toMatch(/fresh session/)
  })

  it("/help prints help; unknown command warns", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    await chatCommand(parseArgv(["chat"]), {
      ...baseDeps(),
      out: s.out,
      createSession: f.factory,
      readLine: scriptedReader(["/help", "/frob", "/exit"]),
    })
    expect(s.stdout()).toMatch(/\/handoff/)
    expect(s.stderr()).toMatch(/unknown command \/frob/)
  })

  it("exits cleanly on EOF (null line)", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    const code = await chatCommand(parseArgv(["chat"]), {
      ...baseDeps(),
      out: s.out,
      createSession: f.factory,
      readLine: scriptedReader([]), // immediate EOF
    })
    expect(code).toBe(0)
    expect(f.sessions[0].close).toHaveBeenCalled()
  })

  it("reports a turn failure but keeps the loop alive", async () => {
    const s = sink()
    const factory = jest.fn(() => {
      const send = jest.fn().mockRejectedValue(new Error("model down"))
      return {
        sessionId: "s_x",
        send,
        close: jest.fn(async () => undefined),
      } as unknown as AgentSession
    })
    const code = await chatCommand(parseArgv(["chat"]), {
      ...baseDeps(),
      out: s.out,
      createSession: factory,
      readLine: scriptedReader(["go", "/exit"]),
    })
    expect(code).toBe(0)
    expect(s.stderr()).toMatch(/turn failed: model down/)
  })

  it("returns exit 2 on config error", async () => {
    const s = sink()
    const code = await chatCommand(parseArgv(["chat"]), {
      out: s.out,
      loadConfig: () => {
        throw new Error("bad")
      },
    })
    expect(code).toBe(2)
  })

  it("mounts the Ink TUI on an interactive terminal", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    const renderTui = jest.fn(
      async (_deps: { config: ResolvedConfig; createSession: unknown; pushHandoff: unknown }) => 0
    )
    const code = await chatCommand(parseArgv(["chat"]), {
      loadConfig: () => cfg(),
      out: s.out,
      createSession: f.factory,
      isTty: () => true,
      renderTui,
    })
    expect(code).toBe(0)
    expect(renderTui).toHaveBeenCalledTimes(1)
    const arg = renderTui.mock.calls[0][0]
    expect(arg.config.cwd).toBe("/work")
    expect(arg.createSession).toBe(f.factory)
    expect(typeof arg.pushHandoff).toBe("function")
  })

  it("falls back to the readline REPL when stdin is not a TTY", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    const renderTui = jest.fn(async () => 0)
    const code = await chatCommand(parseArgv(["chat"]), {
      ...baseDeps(),
      out: s.out,
      createSession: f.factory,
      isTty: () => false,
      renderTui,
      readLine: scriptedReader(["hello", "/exit"]),
    })
    expect(code).toBe(0)
    expect(renderTui).not.toHaveBeenCalled()
    expect(s.stdout()).toMatch(/reply/)
  })
})
