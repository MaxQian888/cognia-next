/** @jest-environment jsdom */

import {
  COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY,
  clearComputerUsePipSession,
  clearComputerUsePipState,
  beginComputerUsePipRun,
  getComputerUsePipAlwaysHidden,
  getComputerUsePipLayoutPreference,
  getComputerUsePipSnapshot,
  publishComputerUseActivity,
  publishComputerUsePipFrame,
  setComputerUsePipAlwaysHidden,
  setComputerUsePipDismissed,
  setComputerUsePipHidden,
  setComputerUsePipLayoutPreference,
  setComputerUsePipRunEnded,
  subscribeComputerUsePip,
  suppressComputerUsePipForCapture,
} from "./computer-use-pip"

afterEach(() => {
  window.localStorage.removeItem(COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY)
  clearComputerUsePipState()
  jest.restoreAllMocks()
})

describe("computer-use PiP state", () => {
  it("retains the latest screenshot while subsequent actions run", () => {
    publishComputerUseActivity("session-1", "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 1280,
      display_height_px: 800,
    })
    publishComputerUseActivity("session-1", "left_click")

    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "left_click",
      phase: "running",
      frame: {
        src: "data:image/png;base64,FRAME",
        width: 1280,
        height: 800,
      },
    })
  })

  it("keeps a newer action current when an older result arrives late", () => {
    beginComputerUsePipRun("session-1", 1)
    const screenshotActivity = publishComputerUseActivity("session-1", "screenshot")
    const clickActivity = publishComputerUseActivity("session-1", "left_click")

    publishComputerUseActivity(
      "session-1",
      "screenshot",
      {
        ok: true,
        output: "FRAME",
        display_width_px: 1280,
        display_height_px: 800,
      },
      screenshotActivity
    )

    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "left_click",
      phase: "running",
      frame: { src: "data:image/png;base64,FRAME" },
    })

    publishComputerUseActivity("session-1", "left_click", { ok: true }, clickActivity)
    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "left_click",
      phase: "complete",
    })
  })

  it("rebuilds completed activity when its pane unmounted during the action", () => {
    const activityId = publishComputerUseActivity("session-1", "screenshot")
    clearComputerUsePipSession("session-1")

    publishComputerUseActivity(
      "session-1",
      "screenshot",
      {
        ok: true,
        output: "LATE_FRAME",
        display_width_px: 1280,
        display_height_px: 800,
      },
      activityId
    )

    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "screenshot",
      phase: "complete",
      frame: { src: "data:image/png;base64,LATE_FRAME" },
    })
  })

  it("isolates sessions and supports reversible per-session hiding", () => {
    publishComputerUseActivity("session-1", "screenshot")
    publishComputerUseActivity("session-2", "scroll")
    setComputerUsePipHidden("session-1", true)

    expect(getComputerUsePipSnapshot("session-1").hidden).toBe(true)
    expect(getComputerUsePipSnapshot("session-2").hidden).toBe(false)

    setComputerUsePipHidden("session-1", false)
    expect(getComputerUsePipSnapshot("session-1").hidden).toBe(false)
  })

  it("ignores activity without a chat session", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeComputerUsePip(listener)
    publishComputerUseActivity(undefined, "screenshot", { ok: false })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("publishes failures without discarding the previous frame", () => {
    publishComputerUseActivity("session-1", "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 10,
      display_height_px: 20,
    })
    publishComputerUseActivity("session-1", "scroll", { ok: false, error: "blocked" })
    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      phase: "error",
      error: "blocked",
      frame: { src: "data:image/png;base64,FRAME" },
    })

    publishComputerUseActivity("session-1", "screenshot", { ok: true, output: "INCOMPLETE" })
    expect(getComputerUsePipSnapshot("session-1").frame?.src).toContain("FRAME")

    publishComputerUseActivity("session-1", "screenshot", {
      ok: true,
      output: "INVALID",
      display_width_px: 0,
      display_height_px: Number.NaN,
    })
    expect(getComputerUsePipSnapshot("session-1").frame?.src).toContain("FRAME")

    publishComputerUseActivity("session-1", "scroll", { ok: false })
    expect(getComputerUsePipSnapshot("session-1").error).toBeNull()
  })

  it("notifies subscribers for the global preference and supports unsubscribe", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeComputerUsePip(listener)
    setComputerUsePipAlwaysHidden(true)
    expect(getComputerUsePipAlwaysHidden()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setComputerUsePipAlwaysHidden(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("stamps the capture time on a fresh screenshot frame", () => {
    jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    publishComputerUseActivity("session-1", "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 50,
    })
    expect(getComputerUsePipSnapshot("session-1").frame?.capturedAt).toBe(1_700_000_000_000)
  })

  it("defaults ended to false, flags it, then clears it on the next run", () => {
    publishComputerUseActivity("session-1", "left_click")
    expect(getComputerUsePipSnapshot("session-1").ended).toBe(false)

    setComputerUsePipRunEnded("session-1")
    expect(getComputerUsePipSnapshot("session-1").ended).toBe(true)

    publishComputerUseActivity("session-1", "screenshot")
    expect(getComputerUsePipSnapshot("session-1").ended).toBe(false)
  })

  it("re-expands on a new run but keeps a mid-run manual hide", () => {
    // A manual hide during a live run must survive further actions in that run.
    publishComputerUseActivity("session-1", "left_click")
    setComputerUsePipHidden("session-1", true)
    publishComputerUseActivity("session-1", "scroll")
    expect(getComputerUsePipSnapshot("session-1").hidden).toBe(true)

    // Once the run ends, the first action of the next run re-expands the surface.
    setComputerUsePipRunEnded("session-1")
    publishComputerUseActivity("session-1", "screenshot")
    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({ hidden: false, ended: false })
  })

  it("uses the explicit run id to reset stale frame and visibility exactly once", () => {
    beginComputerUsePipRun("session-1", 7)
    publishComputerUseActivity("session-1", "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 50,
    })
    setComputerUsePipHidden("session-1", true)

    beginComputerUsePipRun("session-1", 7)
    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      runId: 7,
      hidden: true,
      frame: { src: "data:image/png;base64,FRAME" },
    })

    beginComputerUsePipRun("session-1", 8)
    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      runId: 8,
      hidden: false,
      dismissed: false,
      ended: false,
      action: null,
      frame: null,
    })
  })

  it("adopts the current run id without dropping activity that arrived before mount", () => {
    publishComputerUseActivity("session-1", "screenshot", {
      ok: true,
      output: "EARLY",
      display_width_px: 100,
      display_height_px: 50,
    })

    beginComputerUsePipRun("session-1", 3)
    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      runId: 3,
      action: "screenshot",
      frame: { src: "data:image/png;base64,EARLY" },
    })
  })

  it("dismisses for the current run and re-shows on the next run", () => {
    publishComputerUseActivity("session-1", "left_click")
    setComputerUsePipDismissed("session-1", true)
    publishComputerUseActivity("session-1", "scroll") // same run keeps it dismissed
    expect(getComputerUsePipSnapshot("session-1").dismissed).toBe(true)

    setComputerUsePipRunEnded("session-1")
    publishComputerUseActivity("session-1", "screenshot") // new run re-shows
    expect(getComputerUsePipSnapshot("session-1").dismissed).toBe(false)
  })

  it("clears a single session without touching the others", () => {
    publishComputerUseActivity("session-1", "screenshot")
    publishComputerUseActivity("session-2", "scroll")

    clearComputerUsePipSession("session-1")
    expect(getComputerUsePipSnapshot("session-1").action).toBeNull()
    expect(getComputerUsePipSnapshot("session-2").action).toBe("scroll")
  })

  it("keeps overlapping captures suppressed until every idempotent release finishes", async () => {
    publishComputerUseActivity("session-1", "screenshot")
    const releaseFirst = await suppressComputerUsePipForCapture("session-1")
    const releaseSecond = await suppressComputerUsePipForCapture("session-1")

    expect(getComputerUsePipSnapshot("session-1").captureSuppressed).toBe(true)
    releaseFirst()
    releaseFirst()
    expect(getComputerUsePipSnapshot("session-1").captureSuppressed).toBe(true)
    releaseSecond()
    expect(getComputerUsePipSnapshot("session-1").captureSuppressed).toBe(false)
  })

  it("updates only valid visual frames without replacing the current action", () => {
    publishComputerUseActivity("session-1", "click_text")
    publishComputerUsePipFrame("session-1", {
      output: "OCR_FRAME",
      width: 800,
      height: 600,
      capturedAt: 123,
    })
    publishComputerUsePipFrame("session-1", {
      output: "",
      width: 0,
      height: Number.NaN,
    })

    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "click_text",
      phase: "running",
      frame: {
        src: "data:image/png;base64,OCR_FRAME",
        width: 800,
        height: 600,
        capturedAt: 123,
      },
    })
  })

  it("normalizes malformed stored layout and survives blocked persistence", () => {
    window.localStorage.setItem(
      COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY,
      JSON.stringify({ alignment: "elsewhere", preferredLongEdge: -1 })
    )
    expect(getComputerUsePipLayoutPreference()).toEqual({
      alignment: "bottomRight",
      preferredLongEdge: 250,
    })

    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(() =>
      setComputerUsePipLayoutPreference({ alignment: "topLeft", preferredLongEdge: 10 })
    ).not.toThrow()
    expect(getComputerUsePipLayoutPreference()).toEqual({
      alignment: "topLeft",
      preferredLongEdge: 220,
    })
  })
})
