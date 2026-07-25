import {
  startLogIngest,
  sidecarExitedLog,
  turnErrorLog,
  type LogIngestSubscriptions,
} from "./log-ingest"
import type { LogInput } from "../state/types"

type Handlers = {
  stdout?: (e: { agentId: string; data: string }) => void
  stderr?: (e: { agentId: string; data: string }) => void
  state?: (e: { agentId: string; state: string }) => void
  exit?: (e: { agentId: string; code: number; signal?: string | null }) => void
}

/** Capture the registered handlers and control when each subscribe resolves. */
function fakeSubs() {
  const h: Handlers = {}
  const offs = { stdout: jest.fn(), stderr: jest.fn(), state: jest.fn(), exit: jest.fn() }
  const subs = {
    onStdout: (cb: NonNullable<Handlers["stdout"]>) => {
      h.stdout = cb
      return Promise.resolve(offs.stdout)
    },
    onStderr: (cb: NonNullable<Handlers["stderr"]>) => {
      h.stderr = cb
      return Promise.resolve(offs.stderr)
    },
    onStateChange: (cb: NonNullable<Handlers["state"]>) => {
      h.state = cb
      return Promise.resolve(offs.state)
    },
    onExit: (cb: NonNullable<Handlers["exit"]>) => {
      h.exit = cb
      return Promise.resolve(offs.exit)
    },
  } as unknown as LogIngestSubscriptions
  return { subs, h, offs }
}

function harness(captureStdout = false) {
  const { subs, h, offs } = fakeSubs()
  const emitted: LogInput[] = []
  const dispose = startLogIngest({
    emit: (e) => emitted.push(e),
    now: () => 42,
    subs,
    captureStdout,
  })
  return { h, offs, emitted, dispose }
}

describe("startLogIngest — external agent channels", () => {
  it("captures stderr at warn, promoting real faults to error", () => {
    const { h, emitted } = harness()
    h.stderr?.({ agentId: "rev", data: "downloading" })
    h.stderr?.({ agentId: "rev", data: "spawn ENOENT" })
    expect(emitted).toEqual([
      { ts: 42, level: "warn", channel: "agent", origin: "rev", message: "downloading" },
      { ts: 42, level: "error", channel: "agent", origin: "rev", message: "spawn ENOENT" },
    ])
  })

  it("splits the multi-line spawn-error payload into one entry per line", () => {
    const { h, emitted } = harness()
    h.stderr?.({ agentId: "rev", data: "Error: nope\n  at foo\n  at bar" })
    expect(emitted).toHaveLength(3)
    // Indentation is preserved — stack-trace shape is part of the diagnostic.
    expect(emitted.map((e) => e.message)).toEqual(["Error: nope", "  at foo", "  at bar"])
  })

  it("ignores stdout by default (it is the ACP protocol channel, not diagnostics)", () => {
    const { h, emitted } = harness()
    expect(h.stdout).toBeUndefined() // not even subscribed
    expect(emitted).toHaveLength(0)
  })

  it("captures stdout at debug when explicitly enabled", () => {
    const { h, emitted } = harness(true)
    h.stdout?.({ agentId: "rev", data: "banner" })
    expect(emitted[0]).toMatchObject({ level: "debug", channel: "agent", message: "banner" })
  })

  it("maps lifecycle transitions, flagging Failed as an error", () => {
    const { h, emitted } = harness()
    h.state?.({ agentId: "rev", state: "Running" })
    h.state?.({ agentId: "rev", state: "Failed" })
    expect(emitted[0]).toMatchObject({ level: "info", message: "agent rev → Running" })
    expect(emitted[1]).toMatchObject({ level: "error", message: "agent rev → Failed" })
  })

  it("maps exits, flagging a non-zero code and naming the signal", () => {
    const { h, emitted } = harness()
    h.exit?.({ agentId: "rev", code: 0 })
    h.exit?.({ agentId: "rev", code: 137, signal: "SIGKILL" })
    expect(emitted[0]).toMatchObject({ level: "info" })
    expect(emitted[1]).toMatchObject({
      level: "error",
      message: "agent rev exited with code 137 (SIGKILL)",
    })
  })
})

describe("startLogIngest — teardown", () => {
  it("unsubscribes every channel on dispose", async () => {
    const { offs, dispose } = harness()
    await Promise.resolve()
    dispose()
    expect(offs.stderr).toHaveBeenCalled()
    expect(offs.state).toHaveBeenCalled()
    expect(offs.exit).toHaveBeenCalled()
  })

  it("unsubscribes a LATE-resolving subscription that landed after dispose", async () => {
    const off = jest.fn()
    let resolve: ((fn: () => void) => void) | undefined
    const subs = {
      onStdout: () => new Promise<() => void>(() => undefined),
      onStderr: () =>
        new Promise<() => void>((r) => {
          resolve = r
        }),
      onStateChange: () => new Promise<() => void>(() => undefined),
      onExit: () => new Promise<() => void>(() => undefined),
    } as unknown as LogIngestSubscriptions

    const dispose = startLogIngest({ emit: jest.fn(), now: () => 1, subs })
    dispose() // disposed BEFORE the subscribe settles
    resolve?.(off)
    await Promise.resolve()
    // Otherwise a dead handler would keep pushing into a disposed coalescer.
    expect(off).toHaveBeenCalled()
  })

  it("survives a rejecting subscription without an unhandled rejection", async () => {
    const subs = {
      onStdout: () => Promise.reject(new Error("no host")),
      onStderr: () => Promise.reject(new Error("no host")),
      onStateChange: () => Promise.reject(new Error("no host")),
      onExit: () => Promise.reject(new Error("no host")),
    } as unknown as LogIngestSubscriptions
    const dispose = startLogIngest({ emit: jest.fn(), now: () => 1, subs })
    await Promise.resolve()
    expect(() => dispose()).not.toThrow()
  })

  it("is safe to dispose twice", async () => {
    const { offs, dispose } = harness()
    await Promise.resolve()
    dispose()
    dispose()
    expect(offs.stderr).toHaveBeenCalledTimes(1)
  })
})

describe("one-off log builders", () => {
  it("builds the sidecar-exited line", () => {
    expect(sidecarExitedLog(7)).toMatchObject({ ts: 7, level: "error", channel: "sidecar" })
  })

  it("builds a turn-error line, carrying the category as origin", () => {
    expect(turnErrorLog(7, "boom", "network")).toMatchObject({
      channel: "system",
      origin: "network",
      message: "boom",
    })
    expect(turnErrorLog(7, "boom")).not.toHaveProperty("origin")
  })
})
