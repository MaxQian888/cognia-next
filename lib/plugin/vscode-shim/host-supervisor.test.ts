import {
  createHostSupervisor,
  MAX_RESTARTS,
  restartDelay,
  STABLE_UPTIME_MS,
  type HostSupervisorDependencies,
} from "./host-supervisor"

const crash = { code: 1, signal: null, intentional: false }

function harness(restart: HostSupervisorDependencies["restart"] = async () => undefined) {
  let now = 0
  const timers: Array<{ callback: () => void; at: number }> = []
  const errors: Array<[string, string | null]> = []
  const deps: HostSupervisorDependencies = {
    restart: jest.fn(restart),
    setError: (pluginId, message) => errors.push([pluginId, message]),
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { callback, at: now + delayMs }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as never)
      if (index >= 0) timers.splice(index, 1)
    },
  }
  const supervisor = createHostSupervisor(deps)
  return {
    supervisor,
    deps,
    errors,
    timers,
    advance(ms: number) {
      now += ms
      const due = timers.filter((entry) => entry.at <= now)
      for (const timer of due) timers.splice(timers.indexOf(timer), 1)
      for (const timer of due) timer.callback()
    },
  }
}

it("backs off 1 s·2ⁿ up to 30 s", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(restartDelay)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
  ])
})

it("restarts a crashed host after the backoff, and calls it running once it starts", () => {
  const h = harness()
  h.supervisor.onStarted("acme")
  h.supervisor.onExited("acme", crash)
  expect(h.supervisor.state("acme")).toMatchObject({
    status: "restarting",
    restarts: 1,
    nextAttemptAt: 1_000,
  })
  h.advance(999)
  expect(h.deps.restart).not.toHaveBeenCalled()
  h.advance(1)
  expect(h.deps.restart).toHaveBeenCalledWith("acme")
  h.supervisor.onStarted("acme")
  expect(h.supervisor.state("acme")).toMatchObject({ status: "running", restarts: 1 })
})

it("gives up after the restart limit and marks the plugin errored", () => {
  const h = harness()
  for (let attempt = 0; attempt < MAX_RESTARTS; attempt += 1) {
    h.supervisor.onStarted("acme")
    h.supervisor.onExited("acme", crash)
    h.advance(restartDelay(attempt))
  }
  h.supervisor.onStarted("acme")
  h.supervisor.onExited("acme", { code: null, signal: 9, intentional: false })
  expect(h.supervisor.state("acme")).toMatchObject({ status: "crashed", restarts: MAX_RESTARTS })
  expect(h.errors.at(-1)).toEqual(["acme", expect.stringContaining("signal 9")])
  // Given up: another exit report changes nothing.
  h.supervisor.onExited("acme", crash)
  expect(h.timers).toHaveLength(0)
  h.supervisor.reset("acme")
  expect(h.supervisor.state("acme")).toBeUndefined()
})

it("forgets old crashes once a host stays up long enough", () => {
  const h = harness()
  h.supervisor.onStarted("acme")
  h.supervisor.onExited("acme", crash)
  h.advance(1_000)
  h.supervisor.onStarted("acme")
  h.advance(STABLE_UPTIME_MS)
  h.supervisor.onExited("acme", crash)
  expect(h.supervisor.state("acme")).toMatchObject({
    restarts: 1,
    nextAttemptAt: expect.any(Number),
  })
  expect(h.timers[0].at - STABLE_UPTIME_MS - 1_000).toBe(1_000)
})

it("an intentional exit is not a crash, and cancels a pending restart", () => {
  const h = harness()
  h.supervisor.onStarted("acme")
  h.supervisor.onExited("acme", crash)
  h.supervisor.onExited("acme", { code: 0, signal: null, intentional: true })
  expect(h.timers).toHaveLength(0)
  expect(h.supervisor.state("acme")).toBeUndefined()
})

it("a restart that fails to start counts as the next failure", async () => {
  const h = harness(async () => {
    throw new Error("no node")
  })
  h.supervisor.onStarted("acme")
  h.supervisor.onExited("acme", crash)
  h.advance(1_000)
  await Promise.resolve()
  await Promise.resolve()
  expect(h.supervisor.state("acme")).toMatchObject({ status: "restarting", restarts: 2 })
})
