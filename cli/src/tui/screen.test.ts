import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  ALT_SCROLL_OFF,
  CLEAR_HOME,
  MOUSE_TRACK_OFF,
  MOUSE_TRACK_ON,
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
  it("enters the alt buffer and clears on a TTY", () => {
    const { stream, writes } = fakeStream(true)
    enterAltScreen(stream)
    expect(writes).toEqual([ALT_SCREEN_ON, CLEAR_HOME])
  })

  it("exits the alt buffer on a TTY", () => {
    const { stream, writes } = fakeStream(true)
    exitAltScreen(stream)
    expect(writes).toEqual([ALT_SCREEN_OFF])
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
    expect(writes).toEqual([ALT_SCREEN_ON, CLEAR_HOME, ALT_SCREEN_OFF])
  })
})

describe("screen (mouse mode)", () => {
  it("scroll mode captures the wheel via SGR tracking", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("scroll", stream)
    expect(writes).toEqual([MOUSE_TRACK_ON])
  })

  it("select mode releases tracking and suppresses alternate-scroll", () => {
    const { stream, writes } = fakeStream(true)
    applyMouseMode("select", stream)
    expect(writes).toEqual([MOUSE_TRACK_OFF, ALT_SCROLL_OFF])
  })

  it("resetMouse turns tracking off", () => {
    const { stream, writes } = fakeStream(true)
    resetMouse(stream)
    expect(writes).toEqual([MOUSE_TRACK_OFF])
  })

  it("is a no-op on a non-TTY stream", () => {
    const { stream, writes } = fakeStream(false)
    applyMouseMode("scroll", stream)
    applyMouseMode("select", stream)
    resetMouse(stream)
    expect(writes).toEqual([])
  })
})
