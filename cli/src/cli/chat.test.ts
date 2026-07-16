/**
 * @jest-environment node
 */
import { interpretLine, chatCommand, launchCommandFromFlags, selectSessionFactory } from "./chat"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import type { AgentSession } from "../agent/session-runner"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

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

describe("launchCommandFromFlags", () => {
  it("maps --continue / -c to /continue", () => {
    expect(launchCommandFromFlags(parseArgv(["chat", "--continue"]))).toBe("/continue")
    expect(launchCommandFromFlags(parseArgv(["chat", "-c"]))).toBe("/continue")
  })

  it("maps --resume <id> to /resume <id> and bare --resume to the picker", () => {
    expect(launchCommandFromFlags(parseArgv(["chat", "--resume", "s-42"]))).toBe("/resume s-42")
    expect(launchCommandFromFlags(parseArgv(["chat", "--resume"]))).toBe("/resume")
  })

  it("returns undefined with no session flags", () => {
    expect(launchCommandFromFlags(parseArgv(["chat"]))).toBeUndefined()
  })

  it("prefers --continue when both flags are passed", () => {
    expect(launchCommandFromFlags(parseArgv(["chat", "-c", "--resume", "s-1"]))).toBe("/continue")
  })
})

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

  it("selects the external session factory for --backend and passes it to Ink", async () => {
    const external = fakeSessionFactory()
    const builtin = fakeSessionFactory()
    const renderTui = jest.fn(
      async (_deps: { config: ResolvedConfig; createSession: unknown; pushHandoff: unknown }) => 0
    )
    await chatCommand(parseArgv(["chat", "--backend", "claude-code"]), {
      loadConfig: (overrides) => ({
        ...cfg(),
        ...(overrides?.agentBackend ? { agentBackend: overrides.agentBackend } : {}),
      }),
      out: sink().out,
      createSession: builtin.factory,
      externalCreateSession: external.factory,
      isTty: () => true,
      renderTui,
    })

    const mounted = renderTui.mock.calls[0][0]
    expect(mounted.config.agentBackend).toBe("claude-code")
    expect(mounted.createSession).toBe(external.factory)
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

  it("threads the --continue launch flag to the TUI as /continue", async () => {
    const f = fakeSessionFactory()
    const renderTui = jest.fn(async (_deps: { initialCommand?: string }) => 0)
    await chatCommand(parseArgv(["chat", "--continue"]), {
      loadConfig: () => cfg(),
      out: sink().out,
      createSession: f.factory,
      isTty: () => true,
      renderTui,
    })
    expect(renderTui.mock.calls[0][0].initialCommand).toBe("/continue")
  })

  it("warns that resume flags need a TTY on the readline path", async () => {
    const s = sink()
    const f = fakeSessionFactory()
    await chatCommand(parseArgv(["chat", "-c"]), {
      ...baseDeps(),
      out: s.out,
      createSession: f.factory,
      isTty: () => false,
      readLine: scriptedReader(["/exit"]),
    })
    expect(s.stderr()).toMatch(/interactive terminal/)
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

describe("selectSessionFactory", () => {
  it("uses builtin by default and external for a preset backend", () => {
    const builtin = fakeSessionFactory().factory
    const external = fakeSessionFactory().factory
    expect(selectSessionFactory(cfg(), builtin, external)).toBe(builtin)
    expect(selectSessionFactory({ ...cfg(), agentBackend: "codex" }, builtin, external)).toBe(
      external
    )
  })
})
