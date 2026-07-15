jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedStartRecord: jest.fn(),
    embedResumeRecord: jest.fn(),
    embedStopRecord: jest.fn(),
    embedDrainRecord: jest.fn(),
  },
}))

import { browserClient } from "@/lib/browser/client"
import { FlowRecorder } from "@/lib/browser/recording/recorder"
import type { RecordedStep } from "@/lib/browser/recording/protocol"

const startRecord = browserClient.embedStartRecord as jest.Mock
const resumeRecord = browserClient.embedResumeRecord as jest.Mock
const stopRecord = browserClient.embedStopRecord as jest.Mock
const drainRecord = browserClient.embedDrainRecord as jest.Mock

const BASE = "http://localhost:3000"

function clickStep(selector: string, at = 1): RecordedStep {
  return {
    act: "click",
    at,
    target: { selector, role: "button", name: "Go", domPath: "body > button" },
  }
}

let now: jest.Mock

function recorder(onChange?: (steps: RecordedStep[]) => void) {
  return new FlowRecorder({ now, onChange, pollMs: 100 })
}

beforeEach(() => {
  jest.useFakeTimers()
  now = jest.fn(() => 1000)
  startRecord.mockReset().mockResolvedValue("1")
  resumeRecord.mockReset().mockResolvedValue("1")
  stopRecord.mockReset().mockResolvedValue("1")
  drainRecord.mockReset().mockResolvedValue([])
})

afterEach(() => {
  jest.useRealTimers()
})

describe("start", () => {
  it("arms the page and seeds the flow with the base url", async () => {
    const rec = recorder()
    await rec.start(BASE)
    expect(startRecord).toHaveBeenCalled()
    expect(rec.current()).toEqual([{ act: "navigate", at: 0, url: BASE }])
    expect(rec.recording).toBe(true)
  })

  it("is not recording before start", () => {
    expect(recorder().recording).toBe(false)
  })

  it("notifies the listener with the seeded step", async () => {
    const onChange = jest.fn()
    await recorder(onChange).start(BASE)
    expect(onChange).toHaveBeenCalledWith([{ act: "navigate", at: 0, url: BASE }])
  })
})

describe("polling", () => {
  it("drains the page's buffer on the interval", async () => {
    drainRecord.mockResolvedValueOnce([clickStep("#go")])
    const rec = recorder()
    await rec.start(BASE)
    await jest.advanceTimersByTimeAsync(100)
    expect(rec.current()).toHaveLength(2)
    expect(rec.current()[1]).toMatchObject({ act: "click" })
  })

  it("does not notify when the page had nothing buffered", async () => {
    const onChange = jest.fn()
    const rec = recorder(onChange)
    await rec.start(BASE)
    onChange.mockClear()
    await jest.advanceTimersByTimeAsync(100)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("survives a drain that throws mid-navigation", async () => {
    drainRecord.mockRejectedValueOnce(new Error("no JS context"))
    const rec = recorder()
    await rec.start(BASE)
    await expect(jest.advanceTimersByTimeAsync(100)).resolves.not.toThrow()
    expect(rec.recording).toBe(true)
  })

  it("ignores a poll after the take ended", async () => {
    const rec = recorder()
    await rec.start(BASE)
    await rec.stop()
    drainRecord.mockClear()
    await rec.poll()
    expect(drainRecord).not.toHaveBeenCalled()
  })

  it("stops polling once stopped", async () => {
    const rec = recorder()
    await rec.start(BASE)
    await rec.stop()
    drainRecord.mockClear()
    await jest.advanceTimersByTimeAsync(500)
    expect(drainRecord).not.toHaveBeenCalled()
  })
})

describe("navigation", () => {
  it("records a navigation reported by the pane", async () => {
    const rec = recorder()
    await rec.start(BASE)
    rec.noteNavigation(`${BASE}/dashboard`)
    expect(rec.current()[1]).toEqual({ act: "navigate", at: 1, url: `${BASE}/dashboard` })
  })

  it("collapses the duplicate report of one navigation", async () => {
    const rec = recorder()
    await rec.start(BASE)
    rec.noteNavigation(`${BASE}/x`)
    rec.noteNavigation(`${BASE}/x`)
    expect(rec.current().filter((s) => s.act === "navigate")).toHaveLength(2)
  })

  it("ignores a navigation reported outside a take", () => {
    const rec = recorder()
    rec.noteNavigation(`${BASE}/x`)
    expect(rec.current()).toEqual([])
  })

  // The critical ordering: on a same-origin navigation the page restored its
  // buffer from sessionStorage, and re-arming before draining would lose the
  // click that caused the navigation.
  it("drains before re-arming on load", async () => {
    const order: string[] = []
    drainRecord.mockImplementation(() => {
      order.push("drain")
      return Promise.resolve([clickStep("#submit")])
    })
    resumeRecord.mockImplementation(() => {
      order.push("resume")
      return Promise.resolve("1")
    })
    const rec = recorder()
    await rec.start(BASE)
    await rec.noteLoaded()
    expect(order).toEqual(["drain", "resume"])
    expect(rec.current()[1]).toMatchObject({ act: "click" })
  })

  it("re-arms with resume, never with a fresh start that would wipe the buffer", async () => {
    const rec = recorder()
    await rec.start(BASE)
    startRecord.mockClear()
    await rec.noteLoaded()
    expect(resumeRecord).toHaveBeenCalled()
    expect(startRecord).not.toHaveBeenCalled()
  })

  it("keeps the take when the page cannot be re-armed", async () => {
    resumeRecord.mockRejectedValueOnce(new Error("dead context"))
    const rec = recorder()
    await rec.start(BASE)
    await expect(rec.noteLoaded()).resolves.toBeUndefined()
    expect(rec.current()).toHaveLength(1)
  })

  it("ignores a load reported outside a take", async () => {
    await recorder().noteLoaded()
    expect(resumeRecord).not.toHaveBeenCalled()
  })
})

describe("editing", () => {
  it("appends a human-authored assertion", async () => {
    const rec = recorder()
    await rec.start(BASE)
    rec.addAssertion("Welcome")
    expect(rec.current()[1]).toEqual({ act: "wait_for", at: 1, text: "Welcome" })
  })

  it("removes a step by index", async () => {
    drainRecord.mockResolvedValueOnce([clickStep("#go")])
    const rec = recorder()
    await rec.start(BASE)
    await jest.advanceTimersByTimeAsync(100)
    rec.removeStep(0)
    expect(rec.current()).toHaveLength(1)
    expect(rec.current()[0]).toMatchObject({ act: "click" })
  })

  it("ignores an out-of-range removal", async () => {
    const rec = recorder()
    await rec.start(BASE)
    rec.removeStep(9)
    rec.removeStep(-1)
    expect(rec.current()).toHaveLength(1)
  })

  it("ignores edits outside a take", () => {
    const rec = recorder()
    rec.addAssertion("x")
    rec.removeStep(0)
    expect(rec.current()).toEqual([])
  })
})

describe("stop", () => {
  it("takes a final drain, disarms the page, and returns the flow", async () => {
    drainRecord.mockResolvedValueOnce([clickStep("#go")])
    now.mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    const rec = recorder()
    await rec.start(BASE)
    const flow = await rec.stop()
    expect(stopRecord).toHaveBeenCalled()
    expect(flow).toMatchObject({ id: "flow_1000", baseUrl: BASE, createdAt: 1000, updatedAt: 2000 })
    expect(flow?.steps).toHaveLength(2)
    expect(rec.recording).toBe(false)
  })

  it("returns null when there was no take", async () => {
    expect(await recorder().stop()).toBeNull()
  })

  it("still returns the flow when disarming the page fails", async () => {
    stopRecord.mockRejectedValueOnce(new Error("dead context"))
    const rec = recorder()
    await rec.start(BASE)
    await expect(rec.stop()).resolves.toMatchObject({ baseUrl: BASE })
  })

  it("cancel abandons the take and clears the steps", async () => {
    const onChange = jest.fn()
    const rec = recorder(onChange)
    await rec.start(BASE)
    await rec.cancel()
    expect(rec.recording).toBe(false)
    expect(rec.current()).toEqual([])
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
