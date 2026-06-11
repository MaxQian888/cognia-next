import { CONVERSATION_SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/generation/summarizer"
import { AUTO_COMPACT_FRACTION } from "@/lib/claude/usage"
import {
  COMPACT_HANDOFF_SNIPPET,
  DEFAULT_KEEP_RECENT,
  buildCompactionSummaryPrompt,
  resolveCompactInstructions,
  resolveCompaction,
} from "./compact-instructions"

describe("compact-instructions", () => {
  describe("buildCompactionSummaryPrompt", () => {
    it("returns the canonical prompt unchanged with no focus", () => {
      expect(buildCompactionSummaryPrompt()).toBe(CONVERSATION_SUMMARY_SYSTEM_PROMPT)
      expect(buildCompactionSummaryPrompt("   ")).toBe(CONVERSATION_SUMMARY_SYSTEM_PROMPT)
    })

    it("appends the focus when provided", () => {
      const out = buildCompactionSummaryPrompt("the API changes")
      expect(out.startsWith(CONVERSATION_SUMMARY_SYSTEM_PROMPT)).toBe(true)
      expect(out).toContain("Focus especially on: the API changes")
    })

    it("trims surrounding whitespace from the focus", () => {
      expect(buildCompactionSummaryPrompt("  test output  ")).toContain(
        "Focus especially on: test output"
      )
    })
  })

  describe("resolveCompactInstructions", () => {
    it("returns the handoff snippet with no focus", () => {
      expect(resolveCompactInstructions()).toBe(COMPACT_HANDOFF_SNIPPET)
      expect(resolveCompactInstructions("")).toBe(COMPACT_HANDOFF_SNIPPET)
    })

    it("appends the focus when provided", () => {
      const out = resolveCompactInstructions("decisions and file paths")
      expect(out.startsWith(COMPACT_HANDOFF_SNIPPET)).toBe(true)
      expect(out).toContain("When compacting, focus on: decisions and file paths")
    })
  })

  it("snippet mentions interruption awareness", () => {
    expect(COMPACT_HANDOFF_SNIPPET.toLowerCase()).toContain("assume")
    expect(COMPACT_HANDOFF_SNIPPET.toLowerCase()).toContain("compaction")
  })

  describe("resolveCompaction", () => {
    it("defaults to enabled, AUTO_COMPACT_FRACTION, keep 6, canonical prompt", () => {
      const r = resolveCompaction({})
      expect(r.enabled).toBe(true)
      expect(r.fraction).toBe(AUTO_COMPACT_FRACTION)
      expect(r.keepRecent).toBe(DEFAULT_KEEP_RECENT)
      expect(r.focus).toBeUndefined()
      expect(r.summaryPrompt).toBe(CONVERSATION_SUMMARY_SYSTEM_PROMPT)
    })

    it("converts the app token-threshold percentage to a fraction", () => {
      expect(resolveCompaction({ appComp: { tokenThreshold: 70 } }).fraction).toBeCloseTo(0.7)
    })

    it("applies session override over character over app", () => {
      const r = resolveCompaction({
        appComp: { enabled: true, tokenThreshold: 90, preserveRecentMessages: 10 },
        charOv: { tokenThreshold: 80, preserveRecentMessages: 8 },
        sessOv: { compressionEnabled: false, tokenThreshold: 50, preserveRecentMessages: 4 },
      })
      expect(r.enabled).toBe(false)
      expect(r.fraction).toBeCloseTo(0.5)
      expect(r.keepRecent).toBe(4)
    })

    it("layers the user focus onto the canonical prompt", () => {
      const r = resolveCompaction({ appComp: { focus: "the API changes" } })
      expect(r.focus).toBe("the API changes")
      expect(r.summaryPrompt).toContain("Focus especially on: the API changes")
    })

    it("uses a strategy's prompt + thresholds, with focus layered on", () => {
      const r = resolveCompaction({
        appComp: { focus: "errors" },
        strategy: {
          id: "p:keyfacts",
          summaryPrompt: "Extract only key facts.",
          keepRecent: 12,
          fraction: 0.75,
        },
      })
      expect(r.fraction).toBe(0.75)
      expect(r.keepRecent).toBe(12)
      expect(r.summaryPrompt).toBe("Extract only key facts.\n\nFocus especially on: errors")
    })

    it("app threshold wins over strategy fraction", () => {
      const r = resolveCompaction({
        appComp: { tokenThreshold: 60 },
        strategy: { id: "s", fraction: 0.9 },
      })
      expect(r.fraction).toBeCloseTo(0.6)
    })
  })
})
