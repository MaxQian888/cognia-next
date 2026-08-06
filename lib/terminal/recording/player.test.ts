/**
 * Tests for the terminal recording player.
 */

import { createPlayer } from "./player"
import type { TerminalRecording } from "./types"

function makeRecording(frames?: Array<[number, "o" | "i", string]>): TerminalRecording {
  return {
    id: "rec-1",
    sessionId: "s1",
    title: "Test",
    header: { version: 2, width: 80, height: 24, duration: 3.0 },
    frames: frames ?? [
      [0.5, "o", "hello"],
      [1.0, "o", " "],
      [1.5, "o", "world"],
      [2.5, "o", "\r\n"],
    ],
    duration: 3.0,
    createdAt: Date.now(),
    sizeBytes: 100,
  }
}

describe("recording/player", () => {
  let clock: number
  let timers: Array<{ cb: () => void; ms: number; id: number }>
  let timerId: number

  beforeEach(() => {
    clock = 0
    timers = []
    timerId = 0
  })

  function makeClock() {
    return () => clock
  }

  function makeScheduler() {
    return (cb: () => void, ms: number) => {
      const id = ++timerId
      timers.push({ cb, ms, id })
      return id as unknown as ReturnType<typeof setTimeout>
    }
  }

  function makeCancelScheduler() {
    return (id: ReturnType<typeof setTimeout>) => {
      timers = timers.filter((t) => t.id !== (id as unknown as number))
    }
  }

  function fireNextTimer() {
    if (timers.length === 0) return
    const next = timers.shift()!
    clock += next.ms
    next.cb()
  }

  describe("initial state", () => {
    it("starts paused at position 0", () => {
      const emitted: string[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: (data) => emitted.push(data),
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      expect(player.state.playing).toBe(false)
      expect(player.state.position).toBe(0)
      expect(player.state.speed).toBe(1)
      expect(player.state.duration).toBe(3.0)
    })
  })

  describe("play", () => {
    it("schedules frames and emits them in order", () => {
      const emitted: string[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: (data) => emitted.push(data),
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.play()
      expect(player.state.playing).toBe(true)

      // Fire timers to advance through frames
      fireNextTimer() // frame at 0.5s
      expect(emitted).toContain("hello")

      fireNextTimer() // frame at 1.0s
      expect(emitted).toContain(" ")

      fireNextTimer() // frame at 1.5s
      expect(emitted).toContain("world")

      fireNextTimer() // frame at 2.5s
      expect(emitted).toContain("\r\n")
    })

    it("stops playing when all frames are emitted", () => {
      const emitted: string[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: (data) => emitted.push(data),
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.play()

      // Fire all 4 timers
      fireNextTimer()
      fireNextTimer()
      fireNextTimer()
      fireNextTimer()

      // After all frames, should schedule one more that ends playback
      fireNextTimer()

      expect(player.state.playing).toBe(false)
      expect(player.state.position).toBe(3.0)
    })
  })

  describe("pause", () => {
    it("pauses playback", () => {
      const emitted: string[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: (data) => emitted.push(data),
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.play()
      fireNextTimer() // first frame
      player.pause()

      expect(player.state.playing).toBe(false)
      expect(emitted).toHaveLength(1)
    })
  })

  describe("seek", () => {
    it("emits all frames up to the target position", () => {
      const emitted: string[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: (data) => emitted.push(data),
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.seek(1.2)

      // Should emit frames at 0.5s and 1.0s (both <= 1.2)
      expect(emitted).toEqual(["hello", " "])
      expect(player.state.position).toBe(1.2)
    })

    it("clamps to duration", () => {
      const emitted: string[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: (data) => emitted.push(data),
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.seek(999)
      expect(player.state.position).toBe(3.0)
      expect(emitted).toHaveLength(4)
    })

    it("clamps to 0", () => {
      const player = createPlayer(makeRecording(), {
        onFrame: () => {},
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.seek(-5)
      expect(player.state.position).toBe(0)
    })
  })

  describe("setSpeed", () => {
    it("changes playback speed", () => {
      const player = createPlayer(makeRecording(), {
        onFrame: () => {},
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.setSpeed(2)
      expect(player.state.speed).toBe(2)
    })

    it("ignores zero or negative speed", () => {
      const player = createPlayer(makeRecording(), {
        onFrame: () => {},
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.setSpeed(0)
      expect(player.state.speed).toBe(1)

      player.setSpeed(-1)
      expect(player.state.speed).toBe(1)
    })
  })

  describe("dispose", () => {
    it("stops playback and cleans up", () => {
      const player = createPlayer(makeRecording(), {
        onFrame: () => {},
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.play()
      player.dispose()

      expect(player.state.playing).toBe(false)
    })
  })

  describe("onStateChange", () => {
    it("fires callback on state changes", () => {
      const states: boolean[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: () => {},
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      player.onStateChange((s) => states.push(s.playing))
      player.play()
      player.pause()

      expect(states).toContain(true)
      expect(states).toContain(false)
    })

    it("unsubscribe works", () => {
      const states: boolean[] = []
      const player = createPlayer(makeRecording(), {
        onFrame: () => {},
        now: makeClock(),
        scheduleTimer: makeScheduler(),
        cancelTimer: makeCancelScheduler(),
      })

      const unsub = player.onStateChange((s) => states.push(s.playing))
      player.play()
      unsub()
      player.pause()

      // Only the play() notification should be there
      expect(states.filter((s) => s === true)).toHaveLength(1)
    })
  })
})
