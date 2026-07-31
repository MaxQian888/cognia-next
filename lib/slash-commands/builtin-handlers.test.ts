// Supplementary tests for the handlers attached to BUILTIN_SLASH_COMMANDS so
// per-file coverage clears 90%. The original `builtin.test.ts` exercises the
// registry structure; this file exercises every handler arm.

const addReferencedPath = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => ({ addReferencedPath }),
  },
}))
jest.mock("./actions/sessions", () => ({
  handleReset: jest.fn(),
  handleResume: jest.fn(),
  handleSessions: jest.fn(),
}))
jest.mock("./actions/diagnostics", () => ({
  handleStatus: jest.fn(),
  handleCost: jest.fn(),
  handleCompact: jest.fn(),
}))

import { BUILTIN_SLASH_COMMANDS } from "./builtin"
import type { SlashCommand, SlashContext } from "./builtin"

function ctx(overrides: Partial<SlashContext> = {}): SlashContext & {
  _pushed: string[]
  _opened: string[]
  _modes: (string | null)[]
  _started: number
} {
  const pushed: string[] = []
  const opened: string[] = []
  const modes: (string | null)[] = []
  let started = 0
  return {
    args: "",
    activeSessionId: null,
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: async () => {
      started += 1
    },
    openSettings: (tab: string) => opened.push(tab),
    setPermissionMode: (m: string | null) => modes.push(m),
    pushSystemMessage: (md: string) => pushed.push(md),
    get _started() {
      return started
    },
    _pushed: pushed,
    _opened: opened,
    _modes: modes,
    ...overrides,
  } as unknown as SlashContext & {
    _pushed: string[]
    _opened: string[]
    _modes: (string | null)[]
    _started: number
  }
}

function find(name: string): SlashCommand {
  const cmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name)
  if (!cmd) throw new Error("missing " + name)
  return cmd
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("/clear handler", () => {
  it("starts a new session", async () => {
    const c = ctx()
    await find("clear").handler!(c)
    expect(c._started).toBe(1)
  })
})

describe("/help handler", () => {
  it("pushes a system message that lists every builtin command grouped by scope", async () => {
    const c = ctx()
    await find("help").handler!(c)
    expect(c._pushed.length).toBe(1)
    const text = c._pushed[0]
    expect(text).toContain("**builtin**")
    expect(text).toContain("/clear")
    expect(text).toContain("/help")
  })
})

describe("/model, /agents, /mcp open settings panels", () => {
  it("model → general, agents → characters, mcp → mcp", async () => {
    const c = ctx()
    await find("model").handler!(c)
    await find("agents").handler!(c)
    await find("mcp").handler!(c)
    expect(c._opened).toEqual(["general", "characters", "mcp"])
  })
})

describe("/permissions handler — cycles modes", () => {
  it("starts at null and cycles forward", async () => {
    const cycle: (string | null)[] = []
    let cur: string | null = null
    for (let i = 0; i < 5; i++) {
      const c = ctx({
        currentPermissionMode: cur as never,
      })
      await find("permissions").handler!(c)
      cur = c._modes[0] ?? null
      cycle.push(cur)
    }
    expect(cycle).toEqual(["acceptEdits", "plan", "bypassPermissions", null, "acceptEdits"])
  })
})

describe("/permission-mode handler", () => {
  it("cycles when no arg is supplied", async () => {
    const c = ctx({ args: "" })
    await find("permission-mode").handler!(c)
    expect(c._modes).toEqual(["acceptEdits"])
  })

  it("sets default → null", async () => {
    const c = ctx({ args: "default" })
    await find("permission-mode").handler!(c)
    expect(c._modes).toEqual([null])
  })

  it.each(["acceptEdits", "plan", "bypassPermissions"])("sets %s directly", async (mode) => {
    const c = ctx({ args: mode })
    await find("permission-mode").handler!(c)
    expect(c._modes).toEqual([mode])
  })

  it("rejects an unknown mode with a system message", async () => {
    const c = ctx({ args: "weird" })
    await find("permission-mode").handler!(c)
    expect(c._modes).toEqual([])
    expect(c._pushed[0]).toMatch(/Unknown permission mode/)
  })
})

describe("/add-dir handler", () => {
  it("prints usage when no path is supplied", async () => {
    const c = ctx({ args: "" })
    await find("add-dir").handler!(c)
    expect(addReferencedPath).not.toHaveBeenCalled()
    expect(c._pushed[0]).toMatch(/Usage:/)
  })

  it("adds the path to referenced paths and confirms with system message", async () => {
    const c = ctx({ args: "  /abs/x  " })
    await find("add-dir").handler!(c)
    expect(addReferencedPath).toHaveBeenCalledWith({
      absolute: "/abs/x",
      relative: "/abs/x",
      isDir: true,
    })
    expect(c._pushed[0]).toContain("/abs/x")
  })
})

describe("/compact is enabled and runs a handler", () => {
  it("routes a manual compaction via a handler (works on both send paths)", () => {
    const c = find("compact")
    expect(c.disabled).not.toBe(true)
    // Converted from a template to a handler so manual compaction works on the
    // generic (AI-SDK) path too, not just Anthropic's literal `/compact`.
    expect(c.template).toBeUndefined()
    expect(typeof c.handler).toBe("function")
  })
})
