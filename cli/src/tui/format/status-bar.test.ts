/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { UsageInfo } from "../state/types"

import {
  buildStatusBar,
  contextGauge,
  progressBar,
  readGitBranch,
  resolveSegments,
} from "./status-bar"

const base: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  model: "claude-x",
  // Per-provider slot mirrors the resolved config so the `model` segment (now
  // resolved via `resolveActiveModel`) shows this, not the legacy top-level pin.
  providers: { anthropic: { model: "claude-x" } },
  cwd: "/work",
}
const usage: UsageInfo = { inputTokens: 1000, outputTokens: 200, totalCostUsd: 0.5 }

/** Build a ResolvedConfig with a statusBar override (keeps segment/theme typing). */
const withSB = (statusBar: ResolvedConfig["statusBar"]): ResolvedConfig => ({ ...base, statusBar })

describe("resolveSegments", () => {
  it("falls back to the default layout", () => {
    expect(resolveSegments(base)).toEqual([
      "model",
      "provider",
      "mode",
      "tokens",
      "ctx",
      "cost",
      "cwd",
    ])
  })

  it("honors a configured segment list + order", () => {
    expect(resolveSegments(withSB({ segments: ["mode", "model"] }))).toEqual(["mode", "model"])
  })

  it("ignores an empty segment list and falls back to the default", () => {
    expect(resolveSegments(withSB({ segments: [] }))).toEqual(resolveSegments(base))
  })
})

describe("buildStatusBar", () => {
  it("renders the default segments with default colors", () => {
    const segs = buildStatusBar({ config: base, usage })
    const byId = Object.fromEntries(segs.map((s) => [s.id, s]))
    expect(byId.model.text).toBe("claude-x")
    expect(byId.model.color).toBe("cyan")
    expect(byId.provider.color).toBe("gray")
    expect(byId.tokens.text).toBe("1.2k tok")
    expect(byId.ctx.text).toContain("% ctx")
    expect(byId.cost.text).toBe("$0.500")
    expect(byId.cwd.text).toBe("/work")
  })

  it("shows the active provider's resolved model, not a stale top-level pin", () => {
    // Legacy top-level pin from a previous DeepSeek session; the active provider
    // is anthropic with its own remembered model. The footer must show the
    // latter — this is the "always shows deepseek" bug the resolver fixes.
    const cfg: ResolvedConfig = {
      ...base,
      provider: "anthropic",
      model: "deepseek-chat",
      providers: { anthropic: { model: "claude-opus-4-8" }, deepseek: { model: "deepseek-chat" } },
    }
    const byId = Object.fromEntries(buildStatusBar({ config: cfg }).map((s) => [s.id, s]))
    expect(byId.model.text).toBe("claude-opus-4-8")
  })

  it("falls back to the catalog default when the active provider has no remembered model", () => {
    // No per-provider model and a stale top-level pin from another provider — the
    // resolver must prefer anthropic's catalog default over the foreign pin.
    const cfg: ResolvedConfig = {
      ...base,
      provider: "anthropic",
      model: "deepseek-chat",
      providers: {},
    }
    const byId = Object.fromEntries(buildStatusBar({ config: cfg }).map((s) => [s.id, s]))
    expect(byId.model.text).not.toBe("deepseek-chat")
    expect(byId.model.text).toBe("claude-sonnet-4-6")
  })

  it("sizes the ctx segment against the per-model window override", () => {
    // 100k prompt tokens; model "claude-x" → 200k pattern fallback = 50%, but a
    // 1M catalog override makes it 10%.
    const ctxUsage: UsageInfo = { inputTokens: 100_000 }
    const fallback = buildStatusBar({ config: base, usage: ctxUsage })
    expect(Object.fromEntries(fallback.map((s) => [s.id, s])).ctx.text).toBe("50% ctx")
    const overridden = buildStatusBar({
      config: base,
      usage: ctxUsage,
      contextWindow: 1_000_000,
    })
    expect(Object.fromEntries(overridden.map((s) => [s.id, s])).ctx.text).toBe("10% ctx")
  })

  it("drops the git segment when not in a repo", () => {
    const segs = buildStatusBar({ config: withSB({ segments: ["git", "model"] }), git: null })
    expect(segs.map((s) => s.id)).toEqual(["model"])
  })

  it("shows the git branch when present", () => {
    const segs = buildStatusBar({ config: withSB({ segments: ["git"] }), git: "main" })
    expect(segs[0].text).toContain("main")
  })

  it("renders the thinking segment only when a non-off level is set", () => {
    expect(buildStatusBar({ config: withSB({ segments: ["thinking"] }) })).toEqual([])
    expect(
      buildStatusBar({
        config: { ...base, thinkingLevel: "off", statusBar: { segments: ["thinking"] } },
      })
    ).toEqual([])
    const segs = buildStatusBar({
      config: { ...base, thinkingLevel: "high", statusBar: { segments: ["thinking"] } },
    })
    expect(segs[0].text).toContain("high")
  })

  it("renders the ultracode tier in the thinking segment", () => {
    const segs = buildStatusBar({
      config: { ...base, thinkingLevel: "ultracode", statusBar: { segments: ["thinking"] } },
    })
    expect(segs[0].text).toContain("🧠 ultracode")
  })

  it("hides the ratelimit segment until a live reading lands, then shows headroom", () => {
    expect(buildStatusBar({ config: withSB({ segments: ["ratelimit"] }) })).toEqual([])
    const segs = buildStatusBar({
      config: withSB({ segments: ["ratelimit"] }),
      rateLimits: {
        capturedAt: 0,
        meters: [
          {
            kind: "tokens",
            label: "Tokens",
            unit: "tok",
            limit: 1000,
            remaining: 120, // 12% headroom ← tightest
            usedPct: 88,
            resetAt: null,
          },
        ],
      },
    })
    expect(segs[0].text).toBe("🚦 12%")
  })

  it("applies the dim theme to every segment", () => {
    const segs = buildStatusBar({ config: withSB({ theme: "dim" }), usage })
    expect(segs.every((s) => s.color === "gray" && s.dim)).toBe(true)
  })

  it("applies the mono theme (no colors)", () => {
    const segs = buildStatusBar({ config: withSB({ theme: "mono" }), usage })
    expect(segs.every((s) => s.color === undefined)).toBe(true)
  })

  it("applies per-segment vivid colors", () => {
    const segs = buildStatusBar({ config: withSB({ theme: "vivid", segments: ["mode"] }) })
    expect(segs[0].color).toBe("yellow")
  })

  it("flags bypassPermissions with a warning glyph and forced colour in any theme", () => {
    const cfg: ResolvedConfig = {
      ...base,
      permissionMode: "bypassPermissions",
      statusBar: { theme: "mono", segments: ["mode"] },
    }
    const segs = buildStatusBar({ config: cfg })
    expect(segs[0].text).toBe("⚠ bypassPermissions")
    // mono theme normally yields no colour; bypass forces a warning colour.
    expect(segs[0].color).toBe("yellow")
  })

  it("leaves a normal mode unstyled in mono theme", () => {
    const segs = buildStatusBar({ config: withSB({ theme: "mono", segments: ["mode"] }) })
    expect(segs[0].text).toBe("default")
    expect(segs[0].color).toBeUndefined()
  })

  it("renders the cache segment only once a turn reports prompt tokens", () => {
    // No usage → hidden.
    expect(buildStatusBar({ config: withSB({ segments: ["cache"] }) })).toEqual([])
    // Prompt of 1000 fresh + 1000 reused → 50% hit.
    const segs = buildStatusBar({
      config: withSB({ segments: ["cache"] }),
      usage: { inputTokens: 1000, cacheReadInputTokens: 1000 },
    })
    expect(segs[0].text).toBe("⚡ 50%")
  })

  it("uses session totals for tokens + cost when given", () => {
    const totals = {
      costUsd: 2,
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
    }
    const segs = buildStatusBar({ config: base, usage, totals })
    const byId = Object.fromEntries(segs.map((s) => [s.id, s]))
    expect(byId.tokens.text).toBe("6.0k tok")
    expect(byId.cost.text).toBe("$2.00")
  })
})

describe("readGitBranch", () => {
  it("parses a ref HEAD into a branch name", () => {
    expect(readGitBranch("/repo", () => "ref: refs/heads/feat/x\n")).toBe("feat/x")
  })

  it("returns a short sha for detached HEAD", () => {
    expect(readGitBranch("/repo", () => "a1b2c3d4e5f6\n")).toBe("a1b2c3d")
  })

  it("returns null when HEAD is unreadable", () => {
    expect(
      readGitBranch("/repo", () => {
        throw new Error("ENOENT")
      })
    ).toBeNull()
  })

  it("returns null for an unrecognized HEAD", () => {
    expect(readGitBranch("/repo", () => "garbage")).toBeNull()
  })
})

describe("progressBar", () => {
  it("fills proportionally", () => {
    expect(progressBar(3, 5)).toBe("▰▰▰▱▱")
    expect(progressBar(0, 5)).toBe("▱▱▱▱▱")
    expect(progressBar(5, 5)).toBe("▰▰▰▰▰")
  })

  it("is all-empty for a zero total", () => {
    expect(progressBar(0, 0)).toBe("▱▱▱▱▱")
  })

  it("clamps overshoot", () => {
    expect(progressBar(99, 5)).toBe("▰▰▰▰▰")
  })
})

describe("contextGauge", () => {
  it("renders a bracketed bar with the percentage", () => {
    expect(contextGauge(50, 6)).toBe("[███▱▱▱] 50%")
    expect(contextGauge(0, 6)).toBe("[▱▱▱▱▱▱] 0%")
    expect(contextGauge(100, 6)).toBe("[██████] 100%")
  })

  it("clamps out-of-range percentages", () => {
    expect(contextGauge(150)).toContain("100%")
    expect(contextGauge(-5)).toContain("0%")
  })
})
