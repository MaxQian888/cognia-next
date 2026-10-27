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
  withComputerUsePipActivity,
  setComputerUsePipTarget,
  getComputerUsePipPresentationIds,
  getComputerUsePipCaptureSuppressed,
  retainComputerUsePipSession,
  COMPUTER_USE_PIP_RETENTION_MS,
  retainComputerUsePipPresentation,
} from "./computer-use-pip"

afterEach(() => {
  window.localStorage.removeItem(COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY)
  clearComputerUsePipState()
  jest.restoreAllMocks()
})

describe("computer-use PiP state", () => {
  it("rejects sourced frames, results and target changes from another chat", () => {
    const source = publishComputerUseActivity("a", "get_app_state")
    publishComputerUseActivity("b", "type", undefined, undefined, null)
    const before = getComputerUsePipSnapshot("b")
    publishComputerUsePipFrame("b", { output: "FROM_A", width: 80, height: 60 }, source)
    publishComputerUseActivity("b", "get_app_state", { ok: false, error: "FROM_A" }, source)
    setComputerUsePipTarget("b", source, "wrong-desktop")
    expect(getComputerUsePipSnapshot("b")).toBe(before)
  })
  it("keeps concurrent app presentations and their controls isolated inside one chat", () => {
    const a = publishComputerUseActivity("chat", "get_app_state", undefined, undefined, null, {
      id: "app-a",
      label: "Editor",
    })
    const b = publishComputerUseActivity("chat", "get_app_state", undefined, undefined, "remote", {
      id: "app-b",
      label: "Browser",
    })
    publishComputerUsePipFrame("chat", { output: "A", width: 800, height: 600 }, a)
    publishComputerUsePipFrame(
      "chat",
      { output: "B", width: 1280, height: 800, targetConnectionId: "remote" },
      b
    )
    expect(getComputerUsePipPresentationIds("chat")).toEqual(["app-a", "app-b"])
    expect(getComputerUsePipSnapshot("chat", "app-a").frame?.src).toContain("A")
    expect(getComputerUsePipSnapshot("chat", "app-b").frame?.src).toContain("B")
    setComputerUsePipHidden("chat", true, "app-a")
    setComputerUsePipDismissed("chat", true, "app-b")
    expect(getComputerUsePipSnapshot("chat", "app-a")).toMatchObject({
      hidden: true,
      dismissed: false,
    })
    expect(getComputerUsePipSnapshot("chat", "app-b")).toMatchObject({
      hidden: false,
      dismissed: true,
    })
  })

  it("notifies only the owning presentation on a frame update", () => {
    const a = publishComputerUseActivity("a", "get_app_state")
    publishComputerUseActivity("b", "get_app_state")
    const own = jest.fn(),
      other = jest.fn()
    const offA = subscribeComputerUsePip(own, "a")
    const offB = subscribeComputerUsePip(other, "b")
    publishComputerUsePipFrame("a", { output: "A", width: 80, height: 60 }, a)
    expect(own).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    offA()
    offB()
  })

  it("retires old presentation identities across repeated explicit runs", () => {
    for (let run = 1; run <= 20; run++) {
      beginComputerUsePipRun("chat", run)
      publishComputerUseActivity("chat", "get_app_state", undefined, undefined, null, {
        id: `generation-${run}`,
      })
      expect(getComputerUsePipPresentationIds("chat")).toEqual([`generation-${run}`])
    }
  })

  it("bounds offscreen target frames while retaining the displayed target", () => {
    const release = retainComputerUsePipPresentation("chat", "visible")
    const visible = publishComputerUseActivity(
      "chat",
      "get_app_state",
      undefined,
      undefined,
      null,
      { id: "visible" }
    )
    publishComputerUsePipFrame("chat", { output: "VISIBLE", width: 80, height: 60 }, visible)
    for (let i = 0; i < 20; i++) {
      const a = publishComputerUseActivity("chat", "get_app_state", undefined, undefined, null, {
        id: `app-${i}`,
      })
      publishComputerUsePipFrame("chat", { output: `FRAME-${i}`, width: 80, height: 60 }, a)
    }
    expect(getComputerUsePipPresentationIds("chat")).toHaveLength(21)
    const cached = getComputerUsePipPresentationIds("chat").filter(
      (id) => getComputerUsePipSnapshot("chat", id).frame
    )
    expect(cached).toHaveLength(9)
    expect(getComputerUsePipSnapshot("chat", "visible").frame?.src).toContain("VISIBLE")
    expect(getComputerUsePipSnapshot("chat", "app-0")).toMatchObject({
      frame: null,
      frameUnavailable: true,
    })
    release()
  })

  it("does not reopen a terminal run when its final action result arrives", () => {
    const a = publishComputerUseActivity("chat", "get_app_state")
    setComputerUsePipRunEnded("chat")
    publishComputerUseActivity("chat", "get_app_state", { ok: true }, a)
    expect(getComputerUsePipSnapshot("chat").ended).toBe(true)
  })

  it("enforces the inactive byte budget and ignores results after retirement", () => {
    jest.useFakeTimers()
    const first = publishComputerUseActivity("bytes", "get_app_state", undefined, undefined, null, {
      id: "a",
    })
    publishComputerUsePipFrame(
      "bytes",
      { output: "A".repeat(9 * 1024 * 1024), width: 80, height: 60 },
      first
    )
    publishComputerUseActivity("bytes", "get_app_state", { ok: true }, first)
    const second = publishComputerUseActivity(
      "bytes",
      "get_app_state",
      undefined,
      undefined,
      null,
      { id: "b" }
    )
    publishComputerUsePipFrame(
      "bytes",
      { output: "B".repeat(9 * 1024 * 1024), width: 80, height: 60 },
      second
    )
    publishComputerUseActivity("bytes", "get_app_state", { ok: true }, second)
    expect(getComputerUsePipSnapshot("bytes", "a")).toMatchObject({
      frame: null,
      frameUnavailable: true,
    })
    expect(getComputerUsePipSnapshot("bytes", "b").frame).not.toBeNull()
    setComputerUsePipRunEnded("bytes")
    jest.advanceTimersByTime(COMPUTER_USE_PIP_RETENTION_MS + 1)
    publishComputerUseActivity("bytes", "get_app_state", { ok: true }, second)
    publishComputerUsePipFrame("bytes", { output: "LATE", width: 80, height: 60 }, second)
    expect(getComputerUsePipPresentationIds("bytes")).toEqual([])
    jest.useRealTimers()
  })

  it("suppresses all local overlay layers across overlapping full-desktop captures", async () => {
    publishComputerUseActivity("a", "screenshot")
    publishComputerUseActivity("b", "get_app_state", undefined, undefined, "remote")
    const first = await suppressComputerUsePipForCapture("a", "local-desktop")
    const second = await suppressComputerUsePipForCapture("b", "local-desktop")
    expect(getComputerUsePipCaptureSuppressed()).toBe(true)
    first()
    first()
    expect(getComputerUsePipCaptureSuppressed()).toBe(true)
    second()
    expect(getComputerUsePipCaptureSuppressed()).toBe(false)
  })

  it("retires completed background previews while preserving every mounted view", () => {
    jest.useFakeTimers()
    const releaseFirst = retainComputerUsePipSession("visible")
    const releaseSecond = retainComputerUsePipSession("visible")
    publishComputerUseActivity("visible", "get_app_state", { ok: true })
    publishComputerUseActivity("background", "get_app_state", { ok: true })
    setComputerUsePipRunEnded("visible")
    setComputerUsePipRunEnded("background")
    releaseFirst()
    jest.advanceTimersByTime(COMPUTER_USE_PIP_RETENTION_MS + 1)
    expect(getComputerUsePipSnapshot("background").action).toBeNull()
    expect(getComputerUsePipSnapshot("visible").action).toBe("get_app_state")
    releaseSecond()
    jest.advanceTimersByTime(COMPUTER_USE_PIP_RETENTION_MS + 1)
    expect(getComputerUsePipSnapshot("visible").action).toBeNull()
    jest.useRealTimers()
  })

  it("rejects a frame whose late target resolution lost to a newer action on another desktop", () => {
    publishComputerUseActivity("s", "type", undefined, undefined, null)
    const remote = publishComputerUseActivity("s", "get_app_state")
    publishComputerUseActivity("s", "type", undefined, undefined, null)
    setComputerUsePipTarget("s", remote, "remote-desktop")
    publishComputerUsePipFrame(
      "s",
      {
        output: "REMOTE",
        width: 800,
        height: 600,
        capturedAt: 100,
        targetConnectionId: "remote-desktop",
      },
      remote
    )
    expect(getComputerUsePipSnapshot("s")).toMatchObject({
      targetConnectionId: null,
      action: "type",
      frame: null,
    })
  })
  it("advances ownership on identical frames without allowing an earlier activity to replace them", () => {
    const first = publishComputerUseActivity("s", "get_app_state")
    const frame = { output: "SAME", width: 80, height: 60, capturedAt: 100 }
    publishComputerUsePipFrame("s", frame, first)
    const second = publishComputerUseActivity("s", "get_app_state")
    publishComputerUsePipFrame("s", frame, second)
    publishComputerUsePipFrame("s", { ...frame, output: "OLD" }, first)
    expect(getComputerUsePipSnapshot("s").frame?.src).toContain("SAME")
  })

  it("isolates capture releases across explicit and implicit run boundaries", async () => {
    publishComputerUseActivity("s", "get_app_state")
    const oldRelease = await suppressComputerUsePipForCapture("s")
    setComputerUsePipRunEnded("s")
    publishComputerUseActivity("s", "get_app_state")
    expect(getComputerUsePipSnapshot("s").captureSuppressed).toBe(false)
    const release = await suppressComputerUsePipForCapture("s")
    oldRelease()
    expect(getComputerUsePipSnapshot("s").captureSuppressed).toBe(true)
    release()
    beginComputerUsePipRun("s", 1)
    const previous = await suppressComputerUsePipForCapture("s")
    beginComputerUsePipRun("s", 2)
    const next = await suppressComputerUsePipForCapture("s")
    previous()
    expect(getComputerUsePipSnapshot("s").captureSuppressed).toBe(true)
    next()
    expect(getComputerUsePipSnapshot("s").captureSuppressed).toBe(false)
  })

  it.each(["refused", "notDelivered", "unknown"])(
    "reports semantic %s outcomes without changing the tool result",
    async (status) => {
      const result = { status, policyDecision: { allowed: false, reason: "Blocked" } }
      expect(
        await withComputerUsePipActivity("s", "perform_action", async () => result, null)
      ).toBe(result)
      expect(getComputerUsePipSnapshot("s")).toMatchObject({
        phase: "error",
        error: "Blocked",
        targetConnectionId: null,
      })
    }
  )

  it("preserves thrown errors and allows unowned calls without creating session state", async () => {
    const error = new Error("failure")
    await expect(
      withComputerUsePipActivity("s", "get_app_state", async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(getComputerUsePipSnapshot("s").phase).toBe("error")
    expect(await withComputerUsePipActivity(undefined, "get_app_state", async () => 42)).toBe(42)
    expect(getComputerUsePipSnapshot("unowned").action).toBeNull()
  })

  it("rejects outdated frames and completions from a previous run", () => {
    beginComputerUsePipRun("s", 1)
    const old = publishComputerUseActivity("s", "get_app_state")
    beginComputerUsePipRun("s", 2)
    const current = publishComputerUseActivity("s", "get_app_state")
    publishComputerUsePipFrame(
      "s",
      { output: "NEW", width: 800, height: 600, capturedAt: 2000 },
      current
    )
    publishComputerUsePipFrame(
      "s",
      { output: "OLD", width: 800, height: 600, capturedAt: 3000 },
      old
    )
    publishComputerUseActivity("s", "get_app_state", { ok: false, error: "old error" }, old)
    expect(getComputerUsePipSnapshot("s")).toMatchObject({
      runId: 2,
      phase: "running",
      error: null,
      frame: { capturedAt: 2000 },
    })
    publishComputerUsePipFrame(
      "s",
      { output: "OLDER", width: 800, height: 600, capturedAt: 1000 },
      current
    )
    expect(getComputerUsePipSnapshot("s").frame?.src).toContain("NEW")
  })

  it("uses the screenshot format and skips identical frame notifications", () => {
    const activity = publishComputerUseActivity("s", "get_app_state")
    const frame = {
      output: "JPEG",
      width: 800,
      height: 600,
      capturedAt: 1000,
      format: "jpeg" as const,
    }
    publishComputerUsePipFrame("s", frame, activity)
    const previous = getComputerUsePipSnapshot("s")
    const listener = jest.fn()
    const unsubscribe = subscribeComputerUsePip(listener)
    publishComputerUsePipFrame("s", frame, activity)
    expect(getComputerUsePipSnapshot("s")).toBe(previous)
    expect(previous.frame?.src).toBe("data:image/jpeg;base64,JPEG")
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

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
