import { describe, expect, it } from "vitest"

import { createLogger, memoryLogger } from "./logger"

describe("createLogger", () => {
  it("writes one JSON object per line with timestamp, level and event", () => {
    const lines: string[] = []
    const logger = createLogger(
      (line) => lines.push(line),
      () => Date.UTC(2026, 9, 2, 10, 0, 0)
    )
    logger.info("run_complete", { profileId: "native", durationMs: 1200, ok: true, reason: null })
    logger.warn("observer_gap")
    logger.error("fatal", { error: "TypeError" })
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true)
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        ts: "2026-10-02T10:00:00.000Z",
        level: "info",
        event: "run_complete",
        profileId: "native",
        durationMs: 1200,
        ok: true,
        reason: null,
      },
      { ts: "2026-10-02T10:00:00.000Z", level: "warn", event: "observer_gap" },
      { ts: "2026-10-02T10:00:00.000Z", level: "error", event: "fatal", error: "TypeError" },
    ])
  })

  it("does not let fields override the timestamp, level or event", () => {
    const lines: string[] = []
    createLogger(
      (line) => lines.push(line),
      () => 0
    ).info("real", { event: "spoof", level: "error", ts: "x" })
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      level: "info",
      event: "real",
    })
    const memory = memoryLogger()
    memory.warn("real", { event: "spoof", level: "info" })
    expect(memory.lines[0]).toMatchObject({ level: "warn", event: "real" })
  })
})
