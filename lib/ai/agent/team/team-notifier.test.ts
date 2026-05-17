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
