/**
 * Tests for the terminal session recorder.
 */

import {
  createRecorder,
  serializeAsciicast,
  parseAsciicast,
  __resetRecorderIdCounterForTesting,
} from "./recorder"
import type { TerminalRecording } from "./types"

describe("recording/recorder", () => {
  let clock: number

  beforeEach(() => {
    clock = 1000000
    __resetRecorderIdCounterForTesting()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function makeClock() {
    return () => clock
  }

  function advanceClock(ms: number) {
    clock += ms
    jest.advanceTimersByTime(ms)
  }

  describe("createRecorder", () => {
    it("starts in idle status", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      expect(rec.status).toBe("idle")
      expect(rec.elapsed).toBe(0)
      expect(rec.frameCount).toBe(0)
    })

    it("transitions to recording on start()", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      expect(rec.status).toBe("recording")
    })

    it("captures output frames", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      advanceClock(100)
      rec.pushOutput("hello")
      advanceClock(200)
      rec.pushOutput("world")
      expect(rec.frameCount).toBe(2)
    })

    it("ignores input frames by default", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      rec.pushInput("echo")
      expect(rec.frameCount).toBe(0)
    })

    it("captures input frames when enabled", () => {
      const rec = createRecorder({ captureInput: true }, { now: makeClock() })
      rec.start(80, 24)
      rec.pushInput("echo hi")
      expect(rec.frameCount).toBe(1)
    })

    it("ignores frames when idle", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.pushOutput("ignored")
      expect(rec.frameCount).toBe(0)
    })

    it("ignores frames when paused", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      rec.pushOutput("before")
      rec.pause()
      rec.pushOutput("during pause")
      expect(rec.frameCount).toBe(1)
    })

    it("resumes after pause without time gap", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      advanceClock(100)
      rec.pushOutput("a")
      rec.pause()
      advanceClock(5000) // 5 seconds paused
      rec.resume()
      advanceClock(100)
      rec.pushOutput("b")

      const recording = rec.stop("s1")
      // Frame "b" should be at ~200ms (not 5200ms)
      expect(recording.frames[1][0]).toBeCloseTo(0.2, 1)
    })

    it("stop() returns a complete recording", () => {
      const rec = createRecorder(
        { title: "Test Recording" },
        { now: makeClock(), generateId: () => "test-id" }
      )
      rec.start(120, 40)
      advanceClock(1000)
      rec.pushOutput("data")
      advanceClock(500)

      const recording = rec.stop("session-abc")

      expect(recording.id).toBe("test-id")
      expect(recording.sessionId).toBe("session-abc")
      expect(recording.title).toBe("Test Recording")
      expect(recording.header.version).toBe(2)
      expect(recording.header.width).toBe(120)
      expect(recording.header.height).toBe(40)
      expect(recording.duration).toBeCloseTo(1.5, 1)
      expect(recording.frames).toHaveLength(1)
      expect(recording.sizeBytes).toBeGreaterThan(0)
    })

    it("throws when stop() called without start()", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      expect(() => rec.stop("s1")).toThrow("never started")
    })

    it("discard() resets to idle", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      rec.pushOutput("data")
      rec.discard()
      expect(rec.status).toBe("idle")
      expect(rec.frameCount).toBe(0)
    })

    it("fires onStateChange callbacks", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      const states: string[] = []
      rec.onStateChange((status) => states.push(status))

      rec.start(80, 24)
      rec.pause()
      rec.resume()
      rec.stop("s1")

      expect(states).toEqual(["recording", "paused", "recording", "stopped"])
    })

    it("unsubscribe removes the listener", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      const states: string[] = []
      const unsub = rec.onStateChange((status) => states.push(status))

      rec.start(80, 24)
      unsub()
      rec.pause()

      expect(states).toEqual(["recording"])
    })

    it("auto-stops after maxDurationSec", () => {
      const rec = createRecorder({ maxDurationSec: 2 }, { now: makeClock() })
      rec.start(80, 24)
      advanceClock(2100)

      expect(rec.status).toBe("stopped")
    })

    it("elapsed is 0 after stop", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      advanceClock(1000)
      rec.stop("s1")
      expect(rec.elapsed).toBe(0)
    })

    it("frame timestamps are relative to start time", () => {
      const rec = createRecorder(undefined, { now: makeClock() })
      rec.start(80, 24)
      advanceClock(500)
      rec.pushOutput("a")
      advanceClock(1500)
      rec.pushOutput("b")

      const recording = rec.stop("s1")
      expect(recording.frames[0][0]).toBeCloseTo(0.5, 2)
      expect(recording.frames[1][0]).toBeCloseTo(2.0, 2)
    })
  })

  describe("serializeAsciicast", () => {
    it("produces valid asciicast v2 format", () => {
      const recording: TerminalRecording = {
        id: "r1",
        sessionId: "s1",
        title: "Test",
        header: { version: 2, width: 80, height: 24, duration: 1.5 },
        frames: [
          [0.5, "o", "hello\r\n"],
          [1.2, "o", "world\r\n"],
        ],
        duration: 1.5,
        createdAt: 1000,
        sizeBytes: 50,
      }

      const output = serializeAsciicast(recording)
      const lines = output.trim().split("\n")

      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0])).toEqual(recording.header)
      expect(JSON.parse(lines[1])).toEqual([0.5, "o", "hello\r\n"])
      expect(JSON.parse(lines[2])).toEqual([1.2, "o", "world\r\n"])
    })
  })

  describe("parseAsciicast", () => {
    it("parses valid asciicast v2 content", () => {
      const content = [
        '{"version":2,"width":80,"height":24}',
        '[0.5,"o","hello"]',
        '[1.0,"o","world"]',
      ].join("\n")

      const { header, frames } = parseAsciicast(content)

      expect(header.version).toBe(2)
      expect(header.width).toBe(80)
      expect(frames).toHaveLength(2)
      expect(frames[0]).toEqual([0.5, "o", "hello"])
    })

    it("handles trailing newline", () => {
      const content = '{"version":2,"width":80,"height":24}\n[0.1,"o","x"]\n'
      const { frames } = parseAsciicast(content)
      expect(frames).toHaveLength(1)
    })

    it("throws on empty content", () => {
      expect(() => parseAsciicast("")).toThrow("Empty")
    })

    it("round-trips with serializeAsciicast", () => {
      const recording: TerminalRecording = {
        id: "r1",
        sessionId: "s1",
        title: "Test",
        header: { version: 2, width: 120, height: 40, duration: 2.0 },
        frames: [
          [0.1, "o", "abc"],
          [1.5, "o", "def"],
        ],
        duration: 2.0,
        createdAt: 1000,
        sizeBytes: 30,
      }

      const serialized = serializeAsciicast(recording)
      const { header, frames } = parseAsciicast(serialized)

      expect(header).toEqual(recording.header)
      expect(frames).toEqual(recording.frames)
    })
  })
})
