import {
  blockerCode,
  blockerDetail,
  PREFLIGHT_BLOCKERS,
  scopeForSelection,
  scopeSummary,
  stepIsSemanticallyEmpty,
  type CaptureScope,
  type CaptureTarget,
  type RecordedStep,
} from "./types"

function step(patch: Partial<RecordedStep> = {}): RecordedStep {
  return { seq: 1, tsMs: 0, kind: "click", ...patch }
}

describe("blockerCode / blockerDetail", () => {
  it("splits a code that carries a detail", () => {
    // `grantMissing:native:screen` — the i18n key is the bare prefix, and the
    // detail (which itself contains a colon) is the rest.
    expect(blockerCode("grantMissing:native:screen")).toBe("grantMissing")
    expect(blockerDetail("grantMissing:native:screen")).toBe("native:screen")
  })

  it("leaves a bare code alone", () => {
    expect(blockerCode("pluginDisabled")).toBe("pluginDisabled")
    expect(blockerDetail("pluginDisabled")).toBeNull()
  })
})

describe("PREFLIGHT_BLOCKERS", () => {
  it("mirrors the stable codes `preflight.rs` emits", () => {
    // Drift here degrades a localized explanation into a raw machine code.
    expect(PREFLIGHT_BLOCKERS.killSwitch).toBe("killSwitchEngaged")
    expect(PREFLIGHT_BLOCKERS.grantMissing).toBe("grantMissing")
    expect(PREFLIGHT_BLOCKERS.screenRecording).toBe("screenRecordingMissing")
    expect(PREFLIGHT_BLOCKERS.platformUnsupported).toBe("platformUnsupported")
  })
})

describe("scopeSummary", () => {
  it("names a window with its title when there is one", () => {
    const scope: CaptureScope = {
      kind: "window",
      windowId: 1,
      processId: 2,
      appName: "Safari",
      title: "Invoices",
    }
    expect(scopeSummary(scope)).toBe("Safari — Invoices")
  })

  it("falls back to the app name alone", () => {
    expect(scopeSummary({ kind: "window", windowId: 1, processId: 2, appName: "Safari" })).toBe(
      "Safari"
    )
  })

  it("reads each application locator shape", () => {
    expect(
      scopeSummary({ kind: "application", locator: { kind: "displayName", displayName: "Figma" } })
    ).toBe("Figma")
    expect(
      scopeSummary({
        kind: "application",
        locator: { kind: "path", path: "/Applications/Figma.app" },
      })
    ).toBe("Figma.app")
    expect(
      scopeSummary({
        kind: "application",
        locator: { kind: "bundleId", bundleId: "com.figma.Desktop" },
      })
    ).toBe("com.figma.Desktop")
  })

  it("leaves the desktop scope to the caller's own copy", () => {
    expect(scopeSummary({ kind: "desktop" })).toBe("")
  })
})

describe("stepIsSemanticallyEmpty", () => {
  it("is true when accessibility, OCR and text all gave nothing", () => {
    expect(stepIsSemanticallyEmpty(step())).toBe(true)
  })

  it("is false when an element has a name", () => {
    expect(stepIsSemanticallyEmpty(step({ element: { name: "Save" } }))).toBe(false)
  })

  it("is false when only an automation id is present", () => {
    expect(stepIsSemanticallyEmpty(step({ element: { automationId: "btnSave" } }))).toBe(false)
  })

  it("is false when OCR read something", () => {
    expect(stepIsSemanticallyEmpty(step({ ocrHint: "Submit order" }))).toBe(false)
  })

  it("is false when the user typed describable text", () => {
    expect(
      stepIsSemanticallyEmpty(step({ kind: "type", text: { kind: "text", value: "hello" } }))
    ).toBe(false)
  })

  it("is TRUE for a secret run — the placeholder describes nothing", () => {
    expect(stepIsSemanticallyEmpty(step({ kind: "type", text: { kind: "sensitive" } }))).toBe(true)
  })

  it("treats whitespace-only labels as empty", () => {
    expect(stepIsSemanticallyEmpty(step({ element: { name: "   " } }))).toBe(true)
  })

  it("is always true for an out-of-scope marker", () => {
    expect(stepIsSemanticallyEmpty(step({ kind: "outOfScope" }))).toBe(true)
  })
})

describe("scopeForSelection", () => {
  const target: CaptureTarget = {
    windowId: 7,
    processId: 8,
    appName: "Safari",
    title: "Invoices",
    focused: true,
    minimized: false,
  }

  it("needs no target for the desktop", () => {
    expect(scopeForSelection("desktop", null)).toEqual({ kind: "desktop" })
  })

  it("carries the identity fields a window scope requires", () => {
    // The native side re-verifies window identity on every capture, so a scope
    // missing these does not deserialize — which is how "window scope" used to
    // silently become no scope at all.
    expect(scopeForSelection("window", target)).toEqual({
      kind: "window",
      windowId: 7,
      processId: 8,
      appName: "Safari",
      title: "Invoices",
    })
  })

  it("omits an empty title rather than sending a blank one", () => {
    expect(scopeForSelection("window", { ...target, title: "" })).toEqual({
      kind: "window",
      windowId: 7,
      processId: 8,
      appName: "Safari",
    })
  })

  it("keys an application scope by name, not by window handle", () => {
    // Application scope follows every window of the app, including dialogs that
    // run under their own pid — a handle would pin it to one of them.
    expect(scopeForSelection("application", target)).toEqual({
      kind: "application",
      locator: { kind: "displayName", displayName: "Safari" },
    })
  })

  it("returns null rather than widening a targetless scoped choice", () => {
    // The load-bearing case: falling back to the desktop here would record more
    // than the user asked for, without telling them.
    expect(scopeForSelection("window", null)).toBeNull()
    expect(scopeForSelection("application", null)).toBeNull()
  })
})
