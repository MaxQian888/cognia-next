import { parseProjectPreference, setProjectPreference } from "./preferences"

describe("parseProjectPreference", () => {
  it("parses each key, accepting string forms from the model", () => {
    expect(parseProjectPreference("max_concurrent_threads", "2")).toEqual({
      ok: true,
      patch: { maxConcurrentThreads: 2 },
    })
    expect(parseProjectPreference("max_concurrent_threads", null)).toEqual({
      ok: true,
      patch: { maxConcurrentThreads: undefined },
    })
    expect(parseProjectPreference("daily_thread_cap", 30)).toEqual({
      ok: true,
      patch: { dailyThreadCap: 30 },
    })
    expect(parseProjectPreference("propose_before_start", "true")).toEqual({
      ok: true,
      patch: { proposeBeforeStart: true },
    })
    expect(parseProjectPreference("auto_fix_pr", false)).toEqual({
      ok: true,
      patch: { autoFixPr: false },
    })
  })

  it("rejects out-of-range values and unknown keys", () => {
    expect(parseProjectPreference("max_concurrent_threads", 0)).toMatchObject({ ok: false })
    expect(parseProjectPreference("daily_thread_cap", 2.5)).toMatchObject({ ok: false })
    expect(parseProjectPreference("daily_thread_cap", null)).toMatchObject({ ok: false })
    expect(parseProjectPreference("auto_fix_pr", "yes")).toMatchObject({ ok: false })
    expect(parseProjectPreference("model", "x")).toMatchObject({
      ok: false,
      error: expect.stringContaining("max_concurrent_threads"),
    })
  })
})

describe("setProjectPreference", () => {
  it("writes only a valid preference", () => {
    const updateCoordinator = jest.fn()
    setProjectPreference("p1", "auto_fix_pr", true, { updateCoordinator })
    expect(updateCoordinator).toHaveBeenCalledWith("p1", { preferences: { autoFixPr: true } })
    setProjectPreference("p1", "auto_fix_pr", "maybe", { updateCoordinator })
    expect(updateCoordinator).toHaveBeenCalledTimes(1)
  })
})
