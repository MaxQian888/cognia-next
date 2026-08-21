// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in coverage, and the literals below document the
// asciicast v2 shapes the recorder and player agree on.
import "./types"
import type {
  AsciicastFrame,
  AsciicastHeader,
  GifExportOptions,
  PlaybackState,
  RecorderOptions,
  RecordingStatus,
  TerminalRecording,
} from "./types"

describe("asciicast v2 shapes", () => {
  it("pins the header version to the literal 2", () => {
    const header: AsciicastHeader = { version: 2, width: 120, height: 30 }
    expect(header.version).toBe(2)
    // Everything past the dimensions is optional — a header written before the
    // recording ends has neither a duration nor a title.
    expect(header.duration).toBeUndefined()
    expect(header.title).toBeUndefined()
  })

  it("carries env + theme metadata for faithful playback", () => {
    const header: AsciicastHeader = {
      version: 2,
      width: 80,
      height: 24,
      timestamp: 1_700_000_000,
      duration: 12.5,
      env: { SHELL: "/bin/zsh", TERM: "xterm-256color" },
      title: "install deps",
      theme: { fg: "#ffffff", bg: "#000000", palette: "#000000:#ff0000" },
    }
    expect(header.env?.SHELL).toBe("/bin/zsh")
    expect(header.theme?.bg).toBe("#000000")
  })

  it("models a frame as the positional [time, type, data] triple", () => {
    const out: AsciicastFrame = [0.5, "o", "hello\r\n"]
    const input: AsciicastFrame = [1.25, "i", "q"]
    const [time, kind, data] = out
    expect(time).toBe(0.5)
    expect(kind).toBe("o")
    expect(data).toBe("hello\r\n")
    expect(input[1]).toBe("i")
  })
})

describe("TerminalRecording row shape", () => {
  it("accepts a complete recording", () => {
    const rec: TerminalRecording = {
      id: "rec_1",
      sessionId: "term_1",
      title: "install deps",
      header: { version: 2, width: 80, height: 24 },
      frames: [[0, "o", "$ "]],
      duration: 3.5,
      createdAt: 1_700_000_000_000,
      sizeBytes: 42,
    }
    expect(rec.frames).toHaveLength(1)
    expect(rec.duration).toBeCloseTo(3.5)
  })
})

describe("option and state shapes", () => {
  it("leaves every RecorderOption optional so `{}` means 'the defaults'", () => {
    const options: RecorderOptions = {}
    expect(options.maxDurationSec).toBeUndefined()
    expect(options.captureInput).toBeUndefined()
  })

  it("enumerates the four recorder states", () => {
    const states: RecordingStatus[] = ["idle", "recording", "paused", "stopped"]
    expect(new Set(states).size).toBe(4)
  })

  it("requires every PlaybackState field — the scrubber reads all four", () => {
    const state: PlaybackState = { position: 1.5, playing: true, speed: 2, duration: 10 }
    expect(state).toEqual({ position: 1.5, playing: true, speed: 2, duration: 10 })
  })

  it("keeps GIF export options fully optional", () => {
    const gif: GifExportOptions = { width: 800, fps: 10, theme: "dark" }
    expect(gif.height).toBeUndefined()
    expect(gif.theme).toBe("dark")
  })
})
