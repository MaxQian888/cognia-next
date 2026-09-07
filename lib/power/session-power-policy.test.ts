import en from "@/i18n/messages/en/sessionPower.json"
import zh from "@/i18n/messages/zh-CN/sessionPower.json"

import {
  DEFAULT_SESSION_POWER_MODE,
  SESSION_POWER_EFFECTS,
  SESSION_POWER_POLICIES,
  describeSessionPowerEffect,
  isSessionPowerMode,
  resolveDefaultPowerMode,
  resolveSessionPowerMode,
  sessionsHoldingScreen,
} from "./session-power-policy"

describe("session power policy", () => {
  it("defaults to the behaviour that shipped before the setting existed", () => {
    // Turning this into "keep the screen on" would light up every existing
    // user's display on upgrade without anyone asking for it.
    expect(DEFAULT_SESSION_POWER_MODE).toBe("allowScreenOff")
    expect(resolveDefaultPowerMode(undefined)).toBe("allowScreenOff")
    expect(resolveDefaultPowerMode({})).toBe("allowScreenOff")
    expect(resolveDefaultPowerMode({ sessionPowerPolicy: "keepScreenOn" })).toBe("keepScreenOn")
  })

  it("rejects junk from a persisted row instead of trusting it", () => {
    expect(isSessionPowerMode("inherit")).toBe(false)
    expect(isSessionPowerMode("keepScreenOn")).toBe(true)
    expect(resolveDefaultPowerMode({ sessionPowerPolicy: "nonsense" as never })).toBe(
      "allowScreenOff"
    )
  })

  it("lists inherit first so the sheet's default choice is the neutral one", () => {
    expect(SESSION_POWER_POLICIES[0]).toBe("inherit")
  })

  it("falls a session through to the app default only when it has no opinion", () => {
    expect(resolveSessionPowerMode(undefined, "keepScreenOn")).toBe("keepScreenOn")
    expect(resolveSessionPowerMode("inherit", "keepScreenOn")).toBe("keepScreenOn")
    // An explicit choice beats the default in BOTH directions: a conversation
    // that opts out must stay opted out when the app default flips on.
    expect(resolveSessionPowerMode("allowScreenOff", "keepScreenOn")).toBe("allowScreenOff")
    expect(resolveSessionPowerMode("keepScreenOn", "allowScreenOff")).toBe("keepScreenOn")
  })

  describe("sessionsHoldingScreen", () => {
    const sessions = [
      { id: "s_on", powerPolicy: "keepScreenOn" as const },
      { id: "s_off", powerPolicy: "allowScreenOff" as const },
      { id: "s_inherit", powerPolicy: "inherit" as const },
      { id: "s_legacy" },
    ]

    it("holds only for conversations that are actually running", () => {
      // The policy promises the screen "while this conversation runs". An idle
      // chat with the policy on must not pin the display.
      expect(
        sessionsHoldingScreen({
          runningSessionIds: [],
          sessions,
          appDefault: "allowScreenOff",
        })
      ).toEqual([])
      expect(
        sessionsHoldingScreen({
          runningSessionIds: ["s_on", "s_off"],
          sessions,
          appDefault: "allowScreenOff",
        })
      ).toEqual(["s_on"])
    })

    it("carries the app default to inheriting and legacy rows", () => {
      expect(
        sessionsHoldingScreen({
          runningSessionIds: ["s_inherit", "s_legacy", "s_off"],
          sessions,
          appDefault: "keepScreenOn",
        })
      ).toEqual(["s_inherit", "s_legacy"])
    })

    it("resolves a running session with no row at all through the default", () => {
      // A turn can start before the row lands in the live query. Treating the
      // unknown session as opted-in when the app default says so keeps the
      // screen from dropping for the first seconds of every run.
      expect(
        sessionsHoldingScreen({
          runningSessionIds: ["s_unknown"],
          sessions,
          appDefault: "keepScreenOn",
        })
      ).toEqual(["s_unknown"])
    })

    it("returns a sorted, de-duplicated list", () => {
      expect(
        sessionsHoldingScreen({
          runningSessionIds: ["s_b", "s_a", "s_b"],
          sessions: [],
          appDefault: "keepScreenOn",
        })
      ).toEqual(["s_a", "s_b"])
    })
  })

  describe("describeSessionPowerEffect", () => {
    it("only promises a held screen when a lock exists", () => {
      expect(describeSessionPowerEffect("keepScreenOn", "desktop")).toBe("screenHeld")
      expect(describeSessionPowerEffect("keepScreenOn", "web-standalone", false)).toBe(
        "screenHoldUnavailable"
      )
    })

    it("warns only the one profile whose turn really can be suspended", () => {
      // Everywhere else the turn executes outside this webview, so a dark
      // screen costs nothing. A standalone browser tab IS the execution plane.
      expect(describeSessionPowerEffect("allowScreenOff", "web-standalone")).toBe(
        "mayPauseWhenHidden"
      )
      for (const profile of [
        "desktop",
        "mobile-companion",
        "cloud-companion",
        "headless",
      ] as const) {
        expect(describeSessionPowerEffect("allowScreenOff", profile)).toBe("runsOnHost")
      }
    })
  })

  it("has a label, a description and an effect line in both locales", () => {
    // The picker builds its keys as `policy.${option}` / `effect.${effect}`,
    // and lint:i18n cannot follow a template literal. Without this, adding a
    // mode or an effect ships a raw key into the UI and no gate notices.
    for (const bundle of [en, zh] as Array<Record<string, Record<string, unknown>>>) {
      for (const policy of SESSION_POWER_POLICIES) {
        expect(bundle.policy?.[policy]).toEqual(
          expect.objectContaining({ label: expect.any(String), description: expect.any(String) })
        )
      }
      for (const effect of SESSION_POWER_EFFECTS) {
        expect(typeof bundle.effect?.[effect]).toBe("string")
      }
    }
  })
})
