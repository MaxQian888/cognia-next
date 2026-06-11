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

const base: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, model: "claude-x", cwd: "/work" }
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

  it("drops the git segment when not in a repo", () => {
    const segs = buildStatusBar({ config: withSB({ segments: ["git", "model"] }), git: null })
    expect(segs.map((s) => s.id)).toEqual(["model"])
  })

  it("shows the git branch when present", () => {
    const segs = buildStatusBar({ config: withSB({ segments: ["git"] }), git: "main" })
    expect(segs[0].text).toContain("main")
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
