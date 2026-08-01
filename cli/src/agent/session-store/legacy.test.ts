import path from "node:path"

import { importLegacyTranscript } from "./legacy"
import { legacyTranscriptPath } from "./paths"
import { createMemoryFs } from "./test-fs"

const HOME = path.join(path.sep, "home", "u", ".cognia")

function transcript(...entries: Array<Record<string, unknown> | string>): string {
  return entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n"
}

describe("importLegacyTranscript", () => {
  it("reports found:false when there is no legacy transcript", () => {
    const result = importLegacyTranscript(HOME, "s1", createMemoryFs())
    expect(result.found).toBe(false)
    expect(result.turns).toEqual([])
    expect(result.loss.fidelity).toBe("unsupported")
  })

  it("projects roles and text onto canonical turns in file order", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]: transcript(
        { ts: 1000, role: "user", content: "hi" },
        { ts: 2000, role: "assistant", content: "hello" }
      ),
    })
    const result = importLegacyTranscript(HOME, "s1", fsx)
    expect(result.found).toBe(true)
    expect(result.turns).toEqual([
      { turnId: "legacy-0", role: "user", text: "hi", at: new Date(1000).toISOString() },
      { turnId: "legacy-1", role: "assistant", text: "hello", at: new Date(2000).toISOString() },
    ])
  })

  it("emits envelopes that materialize back to the same conversation", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]: transcript(
        { ts: 1000, role: "user", content: "hi" },
        { ts: 2000, role: "assistant", content: "hello" }
      ),
    })
    const result = importLegacyTranscript(HOME, "s1", fsx)
    expect(result.envelopes.map((e) => e.event.kind)).toEqual(["user-input", "text-delta"])
    expect(result.envelopes.every((e) => e.schemaVersion === 1)).toBe(true)
    expect(result.envelopes.every((e) => e.runtime === "legacy")).toBe(true)
  })

  it("counts unparsable and non-entry lines into the loss report instead of skipping them", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]: transcript(
        { ts: 1, role: "user", content: "kept" },
        "{ not json",
        { ts: 2, notATranscriptEntry: true },
        { ts: 3, role: "assistant", content: "also kept" }
      ),
    })
    const result = importLegacyTranscript(HOME, "s1", fsx)
    expect(result.turns.map((t) => t.text)).toEqual(["kept", "also kept"])
    expect(result.invalidLines).toBe(2)
    const dropped = result.loss.losses.filter((l) => l.path.startsWith("legacy.line"))
    expect(dropped).toHaveLength(2)
    expect(dropped[0]?.detail).toContain("not valid JSON")
    expect(dropped[1]?.detail).toContain("not a transcript entry")
  })

  it("declares contextual fidelity and names what the flat format cannot carry", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]: transcript({ ts: 1, role: "user", content: "hi" }),
    })
    const result = importLegacyTranscript(HOME, "s1", fsx)
    expect(result.loss.fidelity).toBe("contextual")
    expect(result.loss.rebuilt).toBe(true)
    expect(result.loss.losses.map((l) => l.path)).toEqual(
      expect.arrayContaining(["toolCalls", "permissions"])
    )
  })

  it("recovers the native session handle, model and provider from entry metadata", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]: transcript(
        { ts: 1, role: "user", content: "hi" },
        {
          ts: 2,
          role: "assistant",
          content: "hello",
          meta: { sdkSessionId: "sdk-1", model: "claude-opus-5", provider: "anthropic" },
        }
      ),
    })
    const result = importLegacyTranscript(HOME, "s1", fsx)
    expect(result.nativeSessionId).toBe("sdk-1")
    expect(result.model).toBe("claude-opus-5")
    expect(result.provider).toBe("anthropic")
  })

  it("never modifies the legacy file it read", () => {
    const source = transcript({ ts: 1, role: "user", content: "hi" })
    const fsx = createMemoryFs({ [legacyTranscriptPath(HOME, "s1")]: source })
    importLegacyTranscript(HOME, "s1", fsx)
    expect(fsx.files.get(legacyTranscriptPath(HOME, "s1"))).toBe(source)
    expect(fsx.files.size).toBe(1)
  })

  it("tolerates a missing timestamp rather than emitting an invalid date", () => {
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1")]: transcript({ role: "user", content: "hi" }),
    })
    const result = importLegacyTranscript(HOME, "s1", fsx)
    expect(result.turns[0]?.at).toBe(new Date(0).toISOString())
  })

  it("honours the --session-dir override when locating the legacy file", () => {
    const override = path.join(path.sep, "tmp", "store")
    const fsx = createMemoryFs({
      [legacyTranscriptPath(HOME, "s1", override)]: transcript({
        ts: 1,
        role: "user",
        content: "hi",
      }),
    })
    expect(importLegacyTranscript(HOME, "s1", fsx, override).found).toBe(true)
    expect(importLegacyTranscript(HOME, "s1", fsx).found).toBe(false)
  })
})
