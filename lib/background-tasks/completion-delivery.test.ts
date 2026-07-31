import {
  BACKGROUND_RESULT_TEXT_CAP,
  deliveryEntryFromJournal,
  formatElapsed,
  frameBackgroundResults,
  frameResumePrompt,
  type BackgroundResultDeliveryEntry,
} from "./completion-delivery"

function entry(over: Partial<BackgroundResultDeliveryEntry> = {}): BackgroundResultDeliveryEntry {
  return {
    runId: "run-1",
    subagentId: "explore",
    status: "done",
    startedAt: 0,
    settledAt: 192_000,
    text: "all findings",
    ...over,
  }
}

describe("formatElapsed", () => {
  it.each([
    [3_000, "3s"],
    [0, "0s"],
    [59_400, "59s"],
    [125_000, "2m 05s"],
    [192_000, "3m 12s"],
    [3_720_000, "1h 02m"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })

  it("clamps negative durations to zero", () => {
    expect(formatElapsed(-500)).toBe("0s")
  })
})

describe("frameBackgroundResults", () => {
  it("frames a done entry deterministically", () => {
    expect(frameBackgroundResults([entry()])).toBe(
      '[background task update] Subagent "explore" (runId run-1) finished in 3m 12s (done):\nall findings'
    )
  })

  it("frames error entries with the error status", () => {
    const framed = frameBackgroundResults([
      entry({ status: "error", text: "halfway output\n[cut off: 429]" }),
    ])
    expect(framed).toContain("(error):")
    expect(framed).toContain("halfway output")
  })

  it("joins multiple entries ordered by settledAt ascending (runId tiebreak)", () => {
    const framed = frameBackgroundResults([
      entry({ runId: "b", settledAt: 2000, text: "second" }),
      entry({ runId: "a", settledAt: 1000, text: "first" }),
      entry({ runId: "c", settledAt: 2000, text: "also-second" }),
    ])
    const order = ["first", "second", "also-second"].map((t) => framed.indexOf(t))
    expect(order[0]).toBeGreaterThanOrEqual(0)
    expect(order[0]).toBeLessThan(order[1])
    // runId "b" < "c" at equal settledAt
    expect(order[1]).toBeLessThan(order[2])
    expect(framed.split("[background task update]")).toHaveLength(4)
  })

  it("caps oversized results and points at collect for the full output", () => {
    const framed = frameBackgroundResults([
      entry({ text: "x".repeat(BACKGROUND_RESULT_TEXT_CAP + 500) }),
    ])
    expect(framed).toContain("truncated")
    expect(framed).toContain('dispatch_agent({collect:"run-1"})')
    expect(framed.length).toBeLessThan(BACKGROUND_RESULT_TEXT_CAP + 300)
  })

  it("does not annotate results at or under the cap", () => {
    const framed = frameBackgroundResults([entry({ text: "y".repeat(100) })])
    expect(framed).not.toContain("truncated")
  })
})

describe("deliveryEntryFromJournal", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    runId: "r1",
    subagentId: "explore",
    status: "done",
    startedAt: 1000,
    settledAt: 2000,
    resultText: "output",
    ...over,
  })

  it("maps a done row onto a done entry", () => {
    expect(deliveryEntryFromJournal(row())).toEqual({
      runId: "r1",
      subagentId: "explore",
      status: "done",
      startedAt: 1000,
      settledAt: 2000,
      text: "output",
    })
  })

  it("returns null for non-terminal rows", () => {
    expect(deliveryEntryFromJournal(row({ status: "running" }))).toBeNull()
    expect(deliveryEntryFromJournal(row({ status: "interrupted" }))).toBeNull()
  })

  it("keeps salvaged partial output ahead of the cut-off note on error rows", () => {
    const entry = deliveryEntryFromJournal(
      row({ status: "error", resultText: "half", error: "429" })
    )
    expect(entry?.text).toBe("half\n\n[Subagent was cut off by an error and did not finish: 429]")
  })

  it("uses the bare error when there is no distinct partial output", () => {
    expect(
      deliveryEntryFromJournal(row({ status: "error", resultText: "boom", error: "boom" }))?.text
    ).toBe("boom")
    expect(
      deliveryEntryFromJournal(row({ status: "error", resultText: undefined, error: "boom" }))?.text
    ).toBe("boom")
    expect(
      deliveryEntryFromJournal(row({ status: "error", resultText: undefined, error: undefined }))
        ?.text
    ).toBe("Background run failed.")
  })

  it("falls back to startedAt when a row has no settledAt", () => {
    expect(deliveryEntryFromJournal(row({ settledAt: undefined }))?.settledAt).toBe(1000)
  })
})

describe("frameResumePrompt", () => {
  it("embeds the prior prompt, outcome, and follow-up in order", () => {
    const framed = frameResumePrompt(
      { prompt: "audit the auth flow", outcome: "found 3 issues" },
      "fix issue 2"
    )
    expect(framed).toBe(
      "You previously worked on this task:\naudit the auth flow\n\n" +
        "Your result was:\nfound 3 issues\n\n" +
        "Follow-up:\nfix issue 2"
    )
  })
})
