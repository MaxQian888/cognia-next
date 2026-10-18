import {
  BUTTON_LEFT,
  BUTTON_RIGHT,
  KEYSYM,
  keysymForChar,
  pressWithModifiers,
  TrackpadGestures,
  type TrackpadSink,
} from "./touch-input"

function recorder() {
  const events: Array<[string, ...number[]]> = []
  const sink: TrackpadSink = {
    move: (dx, dy) => events.push(["move", dx, dy]),
    buttons: (mask) => events.push(["buttons", mask]),
    scroll: (dy) => events.push(["scroll", dy]),
  }
  const timers: Array<() => void> = []
  const gestures = new TrackpadGestures(sink, {
    speed: 2,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: (handle) => {
      timers[(handle as number) - 1] = () => undefined
    },
  })
  return { events, gestures, fireTimers: () => timers.splice(0).forEach((fn) => fn()) }
}

describe("TrackpadGestures", () => {
  it("moves the pointer relatively and clicks on a quick tap only", () => {
    const { events, gestures } = recorder()
    gestures.down(1, 100, 100, 0)
    gestures.up(1, 100)
    expect(events).toEqual([
      ["buttons", BUTTON_LEFT],
      ["buttons", 0],
    ])
    events.length = 0
    gestures.down(1, 100, 100, 0)
    gestures.move(1, 110, 95)
    gestures.move(1, 130, 95)
    gestures.up(1, 100)
    // A drag moves (scaled by speed) and never clicks.
    expect(events).toEqual([
      ["move", 20, -10],
      ["move", 40, 0],
    ])
    events.length = 0
    gestures.down(1, 0, 0, 0)
    gestures.up(1, 400)
    expect(events).toEqual([])
  })

  it("holds the button for a press-and-drag until the finger lifts", () => {
    const { events, gestures, fireTimers } = recorder()
    gestures.down(1, 50, 50, 0)
    fireTimers()
    gestures.move(1, 80, 50)
    gestures.up(1, 900)
    expect(events).toEqual([
      ["buttons", BUTTON_LEFT],
      ["move", 60, 0],
      ["buttons", 0],
    ])
  })

  it("does not start a drag once the finger has moved", () => {
    const { events, gestures, fireTimers } = recorder()
    gestures.down(1, 0, 0, 0)
    gestures.move(1, 30, 0)
    fireTimers()
    gestures.up(1, 900)
    expect(events).toEqual([["move", 60, 0]])
  })

  it("right-clicks on a two-finger tap and scrolls on a two-finger drag", () => {
    const { events, gestures } = recorder()
    gestures.down(1, 10, 10, 0)
    gestures.down(2, 40, 10, 20)
    gestures.up(2, 100)
    gestures.up(1, 120)
    expect(events).toEqual([
      ["buttons", BUTTON_RIGHT],
      ["buttons", 0],
    ])
    events.length = 0
    gestures.down(1, 10, 100, 0)
    gestures.down(2, 40, 100, 10)
    gestures.move(1, 10, 80)
    gestures.move(2, 40, 80)
    gestures.up(1, 300)
    gestures.up(2, 310)
    // Fingers moving up scroll down the page, like a trackpad; no click.
    expect(events.every(([kind]) => kind === "scroll")).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  it("releases a held button when the system cancels the touch", () => {
    const { events, gestures, fireTimers } = recorder()
    gestures.down(1, 0, 0, 0)
    fireTimers()
    gestures.cancel()
    expect(events).toEqual([
      ["buttons", BUTTON_LEFT],
      ["buttons", 0],
    ])
    // Events for a pointer it no longer tracks are ignored.
    gestures.move(1, 5, 5)
    gestures.up(1, 10)
    expect(events).toHaveLength(2)
  })
})

describe("keysyms", () => {
  it("maps typed characters the way X11 defines", () => {
    expect(keysymForChar("a")).toBe(0x61)
    expect(keysymForChar("é")).toBe(0xe9)
    expect(keysymForChar("中")).toBe(0x01004e2d)
    expect(keysymForChar("\n")).toBe(KEYSYM.Return)
    expect(keysymForChar("\t")).toBe(KEYSYM.Tab)
    expect(keysymForChar("\u0007")).toBeNull()
    expect(keysymForChar("")).toBeNull()
  })

  it("wraps a key in its latched modifiers, released in reverse", () => {
    const sent: Array<[number, boolean | undefined]> = []
    pressWithModifiers((keysym, down) => sent.push([keysym, down]), 0x63, ["ctrl", "alt"])
    expect(sent).toEqual([
      [KEYSYM.Control_L, true],
      [KEYSYM.Alt_L, true],
      [0x63, true],
      [0x63, false],
      [KEYSYM.Alt_L, false],
      [KEYSYM.Control_L, false],
    ])
  })
})
