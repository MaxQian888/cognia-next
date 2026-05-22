/**
 * @jest-environment jsdom
 */

const mockInvoke = jest.fn()

interface MockChannel<T> {
  onmessage: ((event: T) => void) | undefined
  __fire(event: T): void
}

const channelInstances: MockChannel<unknown>[] = []

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class<T> {
    onmessage: ((event: T) => void) | undefined
    constructor() {
      this.onmessage = undefined
      channelInstances.push(this as unknown as MockChannel<unknown>)
    }
    __fire(event: T): void {
      this.onmessage?.(event)
    }
  },
}))

import { TerminalSession, listAllTerminals, listTerminalsForProject } from "./session"
import type { SessionInfo, TerminalEvent } from "./types"

const baseInfo: SessionInfo = {
  id: "sess-1",
  projectId: "proj-a",
  extensionId: null,
  origin: "local",
  shell: "/bin/bash",
}

function lastChannel(): MockChannel<TerminalEvent> {
  const ch = channelInstances[channelInstances.length - 1]
  if (!ch) throw new Error("no channel constructed")
  return ch as MockChannel<TerminalEvent>
}

beforeEach(() => {
  mockInvoke.mockReset()
  channelInstances.length = 0
})

describe("TerminalSession.spawn", () => {
  it("invokes terminal_spawn with the request and channel and surfaces the session info", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "terminal_spawn") return { session: baseInfo }
      throw new Error(`unexpected ${cmd}`)
    })

    const session = await TerminalSession.spawn({
      shell: "/bin/bash",
      rows: 24,
      cols: 80,
    })

    expect(session.id).toBe("sess-1")
    expect(session.info).toEqual(baseInfo)
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_spawn",
      expect.objectContaining({
        req: expect.objectContaining({ shell: "/bin/bash", rows: 24 }),
        onEvent: expect.any(Object),
      })
    )
  })
})

describe("event dispatch", () => {
  async function spawn(): Promise<TerminalSession> {
    mockInvoke.mockResolvedValueOnce({ session: baseInfo })
    return TerminalSession.spawn({ shell: "/bin/bash", rows: 24, cols: 80 })
  }

  it("converts data event bytes to Uint8Array for subscribers", async () => {
    const session = await spawn()
    const seen: Uint8Array[] = []
    session.onData((b) => seen.push(b))
    lastChannel().__fire({ kind: "data", bytes: [104, 105] })
    expect(seen).toHaveLength(1)
    expect(Array.from(seen[0]!)).toEqual([104, 105])
  })

  it("forwards integration events without rewrapping", async () => {
    const session = await spawn()
    const seen: unknown[] = []
    session.onIntegration((e) => seen.push(e))
    lastChannel().__fire({ kind: "integration", event: { kind: "prompt_start" } })
    lastChannel().__fire({
      kind: "integration",
      event: { kind: "command_end", exit_code: 1 },
    })
    expect(seen).toEqual([{ kind: "prompt_start" }, { kind: "command_end", exit_code: 1 }])
  })

  it("fires exit listeners and updates isExited / lastExitCode", async () => {
    const session = await spawn()
    let captured: number | null | undefined
    session.onExit((code) => {
      captured = code
    })
    lastChannel().__fire({ kind: "exit", code: 42 })
    expect(captured).toBe(42)
    expect(session.isExited).toBe(true)
    expect(session.lastExitCode).toBe(42)
  })

  it("invokes onExit immediately for late subscribers", async () => {
    const session = await spawn()
    lastChannel().__fire({ kind: "exit", code: 0 })
    let captured: number | null | undefined
    session.onExit((code) => {
      captured = code
    })
    await Promise.resolve()
    expect(captured).toBe(0)
  })

  it("unsubscribe returned from onData stops further dispatch", async () => {
    const session = await spawn()
    const seen: Uint8Array[] = []
    const off = session.onData((b) => seen.push(b))
    lastChannel().__fire({ kind: "data", bytes: [1] })
    off()
    lastChannel().__fire({ kind: "data", bytes: [2] })
    expect(seen).toHaveLength(1)
  })

  it("swallows listener exceptions and keeps fanning out", async () => {
    const session = await spawn()
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const seen: Uint8Array[] = []
    session.onData(() => {
      throw new Error("boom")
    })
    session.onData((b) => seen.push(b))
    lastChannel().__fire({ kind: "data", bytes: [3] })
    expect(seen).toHaveLength(1)
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })
})

describe("write / resize / kill", () => {
  async function spawn(): Promise<TerminalSession> {
    mockInvoke.mockResolvedValueOnce({ session: baseInfo })
    return TerminalSession.spawn({ shell: "/bin/bash", rows: 24, cols: 80 })
  }

  it("encodes string input to bytes and calls terminal_write", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.write("hi")
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_write", {
      id: "sess-1",
      data: [104, 105],
    })
  })

  it("passes Uint8Array input as array on the wire", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.write(new Uint8Array([1, 2, 3]))
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_write", {
      id: "sess-1",
      data: [1, 2, 3],
    })
  })

  it("clamps resize dimensions to at least 1", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.resize(0, -3)
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_resize", {
      id: "sess-1",
      rows: 1,
      cols: 1,
    })
  })

  it("floors fractional resize dimensions", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.resize(24.7, 80.4)
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_resize", {
      id: "sess-1",
      rows: 24,
      cols: 80,
    })
  })

  it("kill is a no-op when already exited", async () => {
    const session = await spawn()
    lastChannel().__fire({ kind: "exit", code: 0 })
    const beforeCallCount = mockInvoke.mock.calls.length
    await session.kill()
    expect(mockInvoke.mock.calls.length).toBe(beforeCallCount)
  })

  it("calls terminal_kill when not yet exited", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.kill()
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_kill", { id: "sess-1" })
  })
})

describe("list helpers", () => {
  it("listTerminalsForProject calls the matching command", async () => {
    mockInvoke.mockResolvedValueOnce([baseInfo])
    const got = await listTerminalsForProject("proj-a")
    expect(got).toEqual([baseInfo])
    expect(mockInvoke).toHaveBeenCalledWith("terminal_list_for_project", {
      projectId: "proj-a",
    })
  })

  it("listAllTerminals calls the matching command", async () => {
    mockInvoke.mockResolvedValueOnce([baseInfo])
    const got = await listAllTerminals()
    expect(got).toEqual([baseInfo])
    expect(mockInvoke).toHaveBeenCalledWith("terminal_list_all")
  })
})
