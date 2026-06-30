import { CONVERSATION_SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/generation/summarizer"
import { AUTO_COMPACT_FRACTION } from "@/lib/claude/usage"
import {
  COMPACT_HANDOFF_SNIPPET,
  DEFAULT_KEEP_RECENT,
  DEFAULT_MAX_SUMMARY_TOKENS,
  POST_COMPACTION_RECOVERY_SNIPPET,
  buildCompactionSummaryPrompt,
  buildPostCompactionRecovery,
  resolveCompactInstructions,
  resolveCompaction,
} from "./compact-instructions"
import { DEFAULT_COMPRESSION_SETTINGS } from "@/types/system/compression"

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

  describe("buildPostCompactionRecovery", () => {
    it("returns the recovery snippet with no durable instructions", () => {
      expect(buildPostCompactionRecovery()).toBe(POST_COMPACTION_RECOVERY_SNIPPET)
      expect(buildPostCompactionRecovery({ durableInstructions: "  " })).toBe(
        POST_COMPACTION_RECOVERY_SNIPPET
      )
    })

    it("appends durable instructions when provided", () => {
      const out = buildPostCompactionRecovery({ durableInstructions: "Keep the kanban in sync" })
      expect(out.startsWith(POST_COMPACTION_RECOVERY_SNIPPET)).toBe(true)
      expect(out).toContain("Instructions still in effect:\nKeep the kanban in sync")
    })

    it("re-asserts summary authority", () => {
      expect(POST_COMPACTION_RECOVERY_SNIPPET.toLowerCase()).toContain("authoritative")
      expect(POST_COMPACTION_RECOVERY_SNIPPET.toLowerCase()).toContain("compaction")
    })
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

    it("threads the dormant-feature fields with documented defaults", () => {
      const r = resolveCompaction({})
      const D = DEFAULT_COMPRESSION_SETTINGS
      expect(r.maxSummaryTokens).toBe(DEFAULT_MAX_SUMMARY_TOKENS)
      expect(r.strategy).toBe(D.strategy)
      expect(r.trigger).toBe(D.trigger)
      expect(r.messageCountThreshold).toBe(D.messageCountThreshold)
      expect(r.preserveSystemMessages).toBe(D.preserveSystemMessages)
      expect(r.useAISummarization).toBe(D.useAISummarization)
      expect(r.importanceThreshold).toBe(D.importanceThreshold)
      expect(r.maxToolResultTokens).toBe(D.maxToolResultTokens)
      expect(r.preserveToolCallMetadata).toBe(D.preserveToolCallMetadata)
      expect(r.recursiveChunkSize).toBe(D.recursiveChunkSize)
      expect(r.retainedFraction).toBeCloseTo(D.retainedThreshold / 100)
      expect(r.captureUndoSnapshot).toBe(D.enableUndo)
      // Draft-only fields are absent unless a compressionModel is configured.
      expect(r.summaryProvider).toBeUndefined()
      expect(r.summaryModel).toBeUndefined()
      expect(r.summary).toBeUndefined()
    })

    it("overrides strategy/trigger/message-count per session and character", () => {
      const r = resolveCompaction({
        appComp: { strategy: "summary", trigger: "token-threshold", messageCountThreshold: 50 },
        charOv: { compressionStrategy: "hybrid", messageCountThreshold: 40 },
        sessOv: { compressionTrigger: "message-count", messageCountThreshold: 30 },
      })
      expect(r.strategy).toBe("hybrid") // character beats app
      expect(r.trigger).toBe("message-count") // session beats app
      expect(r.messageCountThreshold).toBe(30) // session beats character/app
    })

    it("surfaces a configured summary model + cap as draft fields", () => {
      const r = resolveCompaction({
        appComp: {
          compressionModel: { provider: "openai", model: "gpt-4o-mini", maxSummaryTokens: 300 },
        },
      })
      expect(r.maxSummaryTokens).toBe(300)
      expect(r.summaryProvider).toBe("openai")
      expect(r.summaryModel).toBe("gpt-4o-mini")
    })

    it("ignores a non-positive maxSummaryTokens and falls back to the default", () => {
      expect(
        resolveCompaction({ appComp: { compressionModel: { maxSummaryTokens: 0 } } })
          .maxSummaryTokens
      ).toBe(DEFAULT_MAX_SUMMARY_TOKENS)
    })
  })
})
