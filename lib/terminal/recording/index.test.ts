/**
 * Barrel surface guard for terminal recording — the recorder panel and the
 * player both import from `@/lib/terminal/recording`, so a dropped re-export
 * fails at the call site rather than in the module that lost it.
 */
import * as recording from "./index"
import { createRecorder, DEFAULT_MAX_DURATION_SEC, DEFAULT_TITLE } from "./recorder"
import { createPlayer } from "./player"

describe("lib/terminal/recording barrel", () => {
  it("re-exports the recorder and player factories by identity", () => {
    expect(recording.createRecorder).toBe(createRecorder)
    expect(recording.createPlayer).toBe(createPlayer)
  })

  it("re-exports the asciicast codec pair", () => {
    expect(typeof recording.serializeAsciicast).toBe("function")
    expect(typeof recording.parseAsciicast).toBe("function")
  })

  it("re-exports the recorder defaults by identity", () => {
    expect(recording.DEFAULT_MAX_DURATION_SEC).toBe(DEFAULT_MAX_DURATION_SEC)
    expect(recording.DEFAULT_TITLE).toBe(DEFAULT_TITLE)
  })

  it("exposes exactly the documented runtime surface", () => {
    expect(Object.keys(recording).sort()).toEqual([
      "DEFAULT_MAX_DURATION_SEC",
      "DEFAULT_TITLE",
      "createPlayer",
      "createRecorder",
      "parseAsciicast",
      "serializeAsciicast",
    ])
  })
})
