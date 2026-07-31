import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  ALT_SCROLL_OFF,
  CLEAR_HOME,
  HIDE_CURSOR,
  SHOW_CURSOR,
  MOUSE_TRACK_OFF,
  MOUSE_TRACK_ON,
  MOUSE_DRAG_OFF,
  MOUSE_DRAG_ON,
  applyMouseMode,
  resetMouse,
  enterAltScreen,
  exitAltScreen,
  type ScreenStream,
} from "./screen"

function fakeStream(isTTY: boolean): { stream: ScreenStream; writes: string[] } {
  const writes: string[] = []
  return { stream: { isTTY, write: (d) => writes.push(d) }, writes }
}

describe("screen (alternate buffer)", () => {
  it("enters the alt buffer, clears, and hides the cursor on a TTY", () => {
    const { stream, writes } = fakeStream(true)
    enterAltScreen(stream)
    expect(writes).toEqual([ALT_SCREEN_ON, CLEAR_HOME, HIDE_CURSOR])
  })

  it("exits the alt buffer and restores the cursor on a TTY", () => {
    const { stream, writes } = fakeStream(true)
    exitAltScreen(stream)
    expect(writes).toEqual([ALT_SCREEN_OFF, SHOW_CURSOR])
  })

  it("is a no-op on a non-TTY stream", () => {
    const { stream, writes } = fakeStream(false)
    enterAltScreen(stream)
    exitAltScreen(stream)
    expect(writes).toEqual([])
  })

  it("round-trips enter → exit", () => {
    const { stream, writes } = fakeStream(true)
    enterAltScreen(stream)
    exitAltScreen(stream)
    expect(writes).toEqual([ALT_SCREEN_ON, CLEAR_HOME, HIDE_CURSOR, ALT_SCREEN_OFF, SHOW_CURSOR])
  })
})

/**
 * Fold a stream of mode escapes into the terminal's EFFECTIVE mouse-tracking
 * state. Modes 1000 / 1002 / 1003 are not independent flags: xterm keeps a
 * single `send_mouse_pos` slot, so setting one selects it and resetting ANY of
 * them turns reporting off wholesale. Ghostty (one `mouse_event` enum) and
 * xterm.js behave the same way, so a DECRST written after the enable silently
 * kills the wheel. Modelling that here is what makes the ordering testable.
 */
function effectiveTracking(writes: string[]): "off" | "normal" | "button" {
  let state: "off" | "normal" | "button" = "off"
  for (const [, mode, action] of writes.join("").matchAll(/\x1b\[\?(\d+)([hl])/g)) {
    if (mode !== "1000" && mode !== "1002" && mode !== "1003") continue
    if (action === "l") state = "off"
    else state = mode === "1000" ? "normal" : "button"
  }
  return state
}

describe("screen (mouse mode)", () => {
  it("scroll mode captures the wheel via SGR tracking, drag reporting off", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("scroll", stream)
    expect(writes).toEqual([MOUSE_DRAG_OFF, MOUSE_TRACK_ON])
  })

  it("scroll mode layers on button-event tracking when drag is requested", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("scroll", stream, { drag: true })
    expect(writes).toEqual([MOUSE_TRACK_ON, MOUSE_DRAG_ON])
  })

  // The regression these pin: `?1002l` written AFTER `?1000h` left the terminal
  // reporting nothing, so the wheel fell back to alternate-scroll — which forges
  // Up/Down arrows that the composer eats as command-history navigation.
  it("scroll mode leaves the terminal actually reporting the wheel", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("scroll", stream)
    expect(effectiveTracking(writes)).toBe("normal")
  })

  it("scroll mode with drag leaves button-event tracking on", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("scroll", stream, { drag: true })
    expect(effectiveTracking(writes)).toBe("button")
  })

  it("re-applying scroll mode over a live drag session still reports the wheel", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("scroll", stream, { drag: true })
    applyMouseMode("scroll", stream)
    expect(effectiveTracking(writes)).toBe("normal")
  })

  it("select mode leaves tracking off", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("scroll", stream)
    applyMouseMode("select", stream)
    expect(effectiveTracking(writes)).toBe("off")
  })

  it("select mode releases tracking and suppresses alternate-scroll", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("select", stream)
    expect(writes).toEqual([MOUSE_DRAG_OFF, MOUSE_TRACK_OFF, ALT_SCROLL_OFF])
  })

  it("select mode never enables drag reporting, even when asked", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("select", stream, { drag: true })
    expect(writes).not.toContain(MOUSE_DRAG_ON)
  })

  it("resetMouse turns drag reporting and tracking off", () => {
    const { stream, writes } = fakeStream(true)
    resetMouse(stream)
    expect(writes).toEqual([MOUSE_DRAG_OFF, MOUSE_TRACK_OFF])
  })

  it("is a no-op on a non-TTY stream", () => {
    const { stream, writes } = fakeStream(false)
    applyMouseMode("scroll", stream)
    applyMouseMode("select", stream)
    resetMouse(stream)
    expect(writes).toEqual([])
  })
})
