import { createTeamNotifier } from "./team-notifier"

const setup = () => {
  const toast = jest.fn()
  const osNotify = jest.fn().mockResolvedValue(undefined)
  const log = jest.fn().mockResolvedValue(undefined)
  let now = 0
  const notifier = createTeamNotifier(
    { runId: "r1", teamId: "t1" },
    { toast, osNotify, log, now: () => now }
  )
  return {
    notifier,
    toast,
    osNotify,
    log,
    setNow: (v: number) => {
      now = v
    },
  }
}

describe("TeamNotifier detail link", () => {
  /**
   * `detailHref` was declared on the payload and forwarded to
   * `notify({ href })`, and a repo-wide search for the field found exactly two
   * hits: the type and the consumer. Nothing set it, so every Squad
   * notification landed in the centre with no way back to the run.
   */
  it("points a notification at the run, using the cockpit's id convention", () => {
    const deliver = jest.fn()
    const notifier = createTeamNotifier({ runId: "run_team_9", teamId: "t1" }, { deliver })
    notifier.notify({ level: "warn", title: "needs input", runId: "run_team_9", teamId: "t1" })
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        detailHref: "/agent-runs?run=execution%3Ateam%3Arun_team_9",
      })
    )
  })

  it("leaves an explicit target alone", () => {
    const deliver = jest.fn()
    const notifier = createTeamNotifier({ runId: "run_team_9", teamId: "t1" }, { deliver })
    notifier.notify({
      level: "warn",
      title: "t",
      runId: "run_team_9",
      teamId: "t1",
      detailHref: "/issues?id=KEY-1",
    })
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ detailHref: "/issues?id=KEY-1" })
    )
  })
})

describe("TeamNotifier", () => {
  it("info level writes event-log only", () => {
    const { notifier, toast, osNotify, log } = setup()
    notifier.notify({ level: "info", title: "hi", runId: "r1", teamId: "t1" })
    expect(log).toHaveBeenCalledTimes(1)
    expect(toast).not.toHaveBeenCalled()
    expect(osNotify).not.toHaveBeenCalled()
  })

  it("warn level writes event-log + toast", () => {
    const { notifier, toast, osNotify, log } = setup()
    notifier.notify({ level: "warn", title: "hi", runId: "r1", teamId: "t1" })
    expect(log).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(osNotify).not.toHaveBeenCalled()
  })

  it("critical level writes all three channels", () => {
    const { notifier, toast, osNotify, log } = setup()
    notifier.notify({ level: "critical", title: "hi", runId: "r1", teamId: "t1" })
    expect(log).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(osNotify).toHaveBeenCalledTimes(1)
  })

  it("dedupeKey suppresses duplicate within 5min window", () => {
    const { notifier, toast, setNow } = setup()
    notifier.notify({ level: "warn", title: "1", runId: "r1", teamId: "t1", dedupeKey: "k" })
    notifier.notify({ level: "warn", title: "2", runId: "r1", teamId: "t1", dedupeKey: "k" })
    expect(toast).toHaveBeenCalledTimes(1)
    setNow(6 * 60 * 1000)
    notifier.notify({ level: "warn", title: "3", runId: "r1", teamId: "t1", dedupeKey: "k" })
    expect(toast).toHaveBeenCalledTimes(2)
  })

  it("different dedupeKeys do not collide", () => {
    const { notifier, toast } = setup()
    notifier.notify({ level: "warn", title: "1", runId: "r1", teamId: "t1", dedupeKey: "a" })
    notifier.notify({ level: "warn", title: "2", runId: "r1", teamId: "t1", dedupeKey: "b" })
    expect(toast).toHaveBeenCalledTimes(2)
  })

  it("no dedupeKey means no dedupe", () => {
    const { notifier, toast } = setup()
    notifier.notify({ level: "warn", title: "1", runId: "r1", teamId: "t1" })
    notifier.notify({ level: "warn", title: "2", runId: "r1", teamId: "t1" })
    expect(toast).toHaveBeenCalledTimes(2)
  })

  it("suspend disables toast and OS notify but log still runs", () => {
    const { notifier, toast, osNotify, log } = setup()
    notifier.suspend()
    notifier.notify({ level: "critical", title: "hi", runId: "r1", teamId: "t1" })
    expect(toast).not.toHaveBeenCalled()
    expect(osNotify).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("resume re-enables toast and OS notify", () => {
    const { notifier, toast, osNotify } = setup()
    notifier.suspend()
    notifier.notify({ level: "critical", title: "1", runId: "r1", teamId: "t1" })
    notifier.resume()
    notifier.notify({ level: "critical", title: "2", runId: "r1", teamId: "t1" })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(osNotify).toHaveBeenCalledTimes(1)
  })

  it("works without deps (production default — silent no-op outside provided channels)", () => {
    const notifier = createTeamNotifier({ runId: "r1", teamId: "t1" })
    expect(() =>
      notifier.notify({ level: "critical", title: "hi", runId: "r1", teamId: "t1" })
    ).not.toThrow()
  })

  it("isolates dep errors so other channels still fire", () => {
    const { notifier, toast, osNotify } = setup()
    toast.mockImplementation(() => {
      throw new Error("toast boom")
    })
    notifier.notify({ level: "critical", title: "hi", runId: "r1", teamId: "t1" })
    expect(osNotify).toHaveBeenCalledTimes(1)
  })
})

describe("TeamNotifier — unified deliver (ADR-0042)", () => {
  const setupDeliver = () => {
    const deliver = jest.fn()
    const toast = jest.fn()
    const osNotify = jest.fn().mockResolvedValue(undefined)
    const log = jest.fn().mockResolvedValue(undefined)
    const openGate = jest.fn()
    const notifier = createTeamNotifier(
      { runId: "r1", teamId: "t1" },
      { deliver, toast, osNotify, log, openGate }
    )
    return { notifier, deliver, toast, osNotify, log, openGate }
  }

  it("emits exactly one deliver per event and bypasses legacy toast/os", () => {
    const { notifier, deliver, toast, osNotify } = setupDeliver()
    notifier.notify({ level: "critical", title: "hi", runId: "r1", teamId: "t1" })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0].level).toBe("critical")
    expect(toast).not.toHaveBeenCalled()
    expect(osNotify).not.toHaveBeenCalled()
  })

  it("delivers info-level events too (center history)", () => {
    const { notifier, deliver, log } = setupDeliver()
    notifier.notify({ level: "info", title: "hi", runId: "r1", teamId: "t1" })
    expect(log).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("still opens the HITL gate for critical + openApproval", () => {
    const { notifier, deliver, openGate } = setupDeliver()
    notifier.notify({
      level: "critical",
      title: "approve",
      runId: "r1",
      teamId: "t1",
      openApproval: { scope: "team", id: "g1" } as never,
    })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(openGate).toHaveBeenCalledTimes(1)
  })

  it("suspend silences deliver but keeps the event-log", () => {
    const { notifier, deliver, log } = setupDeliver()
    notifier.suspend()
    notifier.notify({ level: "critical", title: "hi", runId: "r1", teamId: "t1" })
    expect(deliver).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
  })
})
