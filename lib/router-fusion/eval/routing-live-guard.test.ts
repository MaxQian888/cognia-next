/**
 * routing-live-guard — the confirmation rule in front of
 * `cognia eval routing --live` (ADR-0188 D20, B6 WP-F2 step 7).
 */

import { LIVE_SMOKE_SETTINGS_ENV } from "@cognia/router-fusion/live/args"
import { formatUsd, LIVE_SMOKE_HARD_CAP_MICROUSD } from "@cognia/router-fusion/live/cap"

import {
  checkRoutingLiveRun,
  checkRoutingLiveSamples,
  ROUTING_LIVE_OPT_IN_ENV,
  type RoutingLiveGuardInput,
} from "./routing-live-guard"

const SETTINGS = "/home/me/cognia-settings.json"
const SAMPLES = "/home/me/routing-samples.json"

function confirmed(overrides: Partial<RoutingLiveGuardInput> = {}): RoutingLiveGuardInput {
  return { env: {}, settingsPath: SETTINGS, samplesPath: SAMPLES, ...overrides }
}

describe("ROUTING_LIVE_OPT_IN_ENV", () => {
  it("is the live smoke's own settings variable, not a second opt-in that can drift", () => {
    expect(ROUTING_LIVE_OPT_IN_ENV).toBe(LIVE_SMOKE_SETTINGS_ENV)
    expect(ROUTING_LIVE_OPT_IN_ENV).toBe("COGNIA_LIVE_SMOKE_SETTINGS")
  })
})

describe("checkRoutingLiveRun", () => {
  it("allows a run that names a settings export and a recorded sample set, under the shared $5 cap", () => {
    expect(checkRoutingLiveRun(confirmed())).toEqual({
      ok: true,
      settingsPath: SETTINGS,
      samplesPath: SAMPLES,
      capMicrousd: LIVE_SMOKE_HARD_CAP_MICROUSD,
      capUsd: formatUsd(LIVE_SMOKE_HARD_CAP_MICROUSD),
      plannedMicrousd: 0,
    })
    // One ceiling in the codebase: the smoke's hard total, $5.
    expect(LIVE_SMOKE_HARD_CAP_MICROUSD).toBe(5_000_000)
  })

  it("trims both paths it hands back", () => {
    const result = checkRoutingLiveRun(
      confirmed({ settingsPath: `  ${SETTINGS}\n`, samplesPath: `\t${SAMPLES}  ` })
    )
    expect(result).toMatchObject({ ok: true, settingsPath: SETTINGS, samplesPath: SAMPLES })
  })

  it("accepts the settings export from the environment variable when no flag names one", () => {
    const result = checkRoutingLiveRun(
      confirmed({ settingsPath: undefined, env: { [LIVE_SMOKE_SETTINGS_ENV]: ` ${SETTINGS} ` } })
    )
    expect(result).toMatchObject({ ok: true, settingsPath: SETTINGS })
  })

  it("prefers the --settings flag over the environment variable", () => {
    const result = checkRoutingLiveRun(
      confirmed({ settingsPath: "/flag.json", env: { [LIVE_SMOKE_SETTINGS_ENV]: "/env.json" } })
    )
    expect(result).toMatchObject({ ok: true, settingsPath: "/flag.json" })
  })

  it("falls back to the environment variable when the flag is blank", () => {
    const result = checkRoutingLiveRun(
      confirmed({ settingsPath: "   ", env: { [LIVE_SMOKE_SETTINGS_ENV]: "/env.json" } })
    )
    expect(result).toMatchObject({ ok: true, settingsPath: "/env.json" })
  })

  it.each([
    ["no flag and no variable", { settingsPath: undefined, env: {} }],
    ["a null flag", { settingsPath: null, env: {} }],
    [
      "a blank flag and a blank variable",
      { settingsPath: "  ", env: { [LIVE_SMOKE_SETTINGS_ENV]: " \n" } },
    ],
    ["an unset variable", { settingsPath: "", env: { [LIVE_SMOKE_SETTINGS_ENV]: undefined } }],
  ])("refuses to start on %s: live is never the default", (_label, overrides) => {
    const result = checkRoutingLiveRun(confirmed(overrides))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("LIVE_NOT_CONFIRMED")
    expect(result.message).toContain("--settings <file>")
    expect(result.message).toContain(LIVE_SMOKE_SETTINGS_ENV)
  })

  it("reads only the environment it is handed, never process.env", () => {
    const previous = process.env[LIVE_SMOKE_SETTINGS_ENV]
    process.env[LIVE_SMOKE_SETTINGS_ENV] = SETTINGS
    try {
      const result = checkRoutingLiveRun(confirmed({ settingsPath: null, env: {} }))
      expect(result).toMatchObject({ ok: false, code: "LIVE_NOT_CONFIRMED" })
    } finally {
      if (previous === undefined) delete process.env[LIVE_SMOKE_SETTINGS_ENV]
      else process.env[LIVE_SMOKE_SETTINGS_ENV] = previous
    }
  })

  it.each([
    ["an undefined", undefined],
    ["a null", null],
    ["a blank", "   "],
  ])("refuses %s --samples: a live report needs recorded rows", (_label, samplesPath) => {
    const result = checkRoutingLiveRun(confirmed({ samplesPath }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("SAMPLES_REQUIRED")
    expect(result.message).toContain("--samples <file>")
  })

  it("checks the settings export before the sample set", () => {
    const result = checkRoutingLiveRun({ env: {}, settingsPath: null, samplesPath: null })
    expect(result).toMatchObject({ ok: false, code: "LIVE_NOT_CONFIRMED" })
  })

  it("treats an explicit zero plan exactly like an omitted one", () => {
    expect(checkRoutingLiveRun(confirmed({ plannedMicrousd: 0 }))).toEqual(
      checkRoutingLiveRun(confirmed())
    )
  })

  it.each([
    ["a negative", -1],
    ["a fractional", 0.5],
    ["a NaN", Number.NaN],
    ["an infinite", Number.POSITIVE_INFINITY],
    ["an unsafe-integer", Number.MAX_SAFE_INTEGER + 2],
  ])("refuses %s planned spend as malformed", (_label, plannedMicrousd) => {
    const result = checkRoutingLiveRun(confirmed({ plannedMicrousd }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("CAP_NOT_ENFORCED")
    expect(result.message).toContain("non-negative whole number of microusd")
    expect(result.message).toContain(String(plannedMicrousd))
  })

  it.each([
    ["one microusd", 1],
    ["exactly the cap", LIVE_SMOKE_HARD_CAP_MICROUSD],
    ["above the cap", LIVE_SMOKE_HARD_CAP_MICROUSD + 1],
  ])(
    "refuses any non-zero plan (%s): a routing experiment books no model call",
    (_label, plannedMicrousd) => {
      const result = checkRoutingLiveRun(confirmed({ plannedMicrousd }))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("CAP_NOT_ENFORCED")
      expect(result.message).toContain("books no model call")
      expect(result.message).toContain("ledger reservation")
    }
  )

  it("refuses a spending plan before it even asks for confirmation", () => {
    const result = checkRoutingLiveRun({ env: {}, plannedMicrousd: 10 })
    expect(result).toMatchObject({ ok: false, code: "CAP_NOT_ENFORCED" })
  })

  describe("when the shared hard cap is missing", () => {
    // The only way to reach the guard's first refusal is a build whose shared
    // ceiling constant is broken, so the constant (not the guard) is replaced.
    function guardWithCap(cap: number): typeof import("./routing-live-guard") {
      let loaded: typeof import("./routing-live-guard") | undefined
      jest.isolateModules(() => {
        jest.doMock("@cognia/router-fusion/live/cap", () => ({
          ...jest.requireActual<typeof import("@cognia/router-fusion/live/cap")>(
            "@cognia/router-fusion/live/cap"
          ),
          LIVE_SMOKE_HARD_CAP_MICROUSD: cap,
        }))
        loaded = jest.requireActual<typeof import("./routing-live-guard")>("./routing-live-guard")
      })
      jest.dontMock("@cognia/router-fusion/live/cap")
      if (!loaded) throw new Error("guard module did not load")
      return loaded
    }

    it.each([
      ["zero", 0],
      ["negative", -5],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
    ])("refuses everything when the cap is %s", (_label, cap) => {
      const guard = guardWithCap(cap)
      const result = guard.checkRoutingLiveRun(confirmed())
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("CAP_NOT_ENFORCED")
      expect(result.message).toContain("shared live hard cap is missing")
    })
  })
})

describe("checkRoutingLiveSamples", () => {
  it("accepts a recorded (live) sample set", () => {
    expect(checkRoutingLiveSamples("live")).toEqual({ ok: true })
  })

  it("refuses a simulated sample set (EVAL-04)", () => {
    const result = checkRoutingLiveSamples("simulated")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("SIMULATED_SAMPLES")
    expect(result.message).toContain("simulated")
    expect(result.message).toContain("EVAL-04")
  })

  it("refuses an empty sample file with its own message", () => {
    const result = checkRoutingLiveSamples(null)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("SIMULATED_SAMPLES")
    expect(result.message).toBe("the sample file carries no samples")
  })
})
