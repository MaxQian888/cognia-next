/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { UsageInfo } from "../state/types"
import { stringWidth } from "../markdown/width"

import {
  buildStatusBar,
  contextGauge,
  fitStatusSegments,
  progressBar,
  readGitBranch,
  resolveSegments,
  type StatusSegmentView,
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
      // Present by default but renders nothing on the built-in backend, so the
      // ordinary footer is unchanged.
      "backend",
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
    // The backend segment ships in the default layout but stays silent here.
    expect(byId.backend).toBeUndefined()
  })

  it("names the hosting agent once one is active", () => {
    const segs = buildStatusBar({ config: { ...base, agentBackend: "codex" }, usage })
    const byId = Object.fromEntries(segs.map((s) => [s.id, s]))
    expect(byId.backend.text).toBe("codex")
    expect(byId.provider.text).toBe("codex")
  })

  it("hides the gauge and cost rather than pricing an external agent with the wrong model", () => {
    const external = { ...base, agentBackend: "codex" }
    const byId = Object.fromEntries(
      buildStatusBar({ config: external, usage }).map((s) => [s.id, s])
    )
    // Both would otherwise come from the built-in provider's catalog window and
    // rate card, neither of which describes what actually ran.
    expect(byId.ctx).toBeUndefined()
    expect(byId.cost).toBeUndefined()
  })

  it("hides the model rather than naming the built-in one while an agent hosts", () => {
    // Same rule as `ctx`/`cost`: the built-in provider's resolved model is not
    // what the external agent runs, so naming it in the footer is a fabrication.
    // `model: undefined` is what `resolveBackendModel` yields for an external
    // backend the user never picked a model for — the state the TUI is really in.
    const byId = Object.fromEntries(
      buildStatusBar({
        config: { ...base, agentBackend: "codex", model: undefined },
        usage,
      }).map((s) => [s.id, s])
    )
    expect(byId.model).toBeUndefined()
    // The built-in provider's own remembered model is still there — untouched,
    // just not presented as the thing answering.
    expect(base.providers.anthropic?.model).toBe("claude-x")
  })

  it("shows the model we explicitly gave the external agent", () => {
    const byId = Object.fromEntries(
      buildStatusBar({
        config: {
          ...base,
          agentBackend: "codex",
          agentBackends: { codex: { model: "gpt-5.6-sol" } },
          model: "gpt-5.6-sol",
        },
        usage,
      }).map((s) => [s.id, s])
    )
    expect(byId.model.text).toBe("gpt-5.6-sol")
  })

  it("shows the gauge again once a real context window is known for the backend", () => {
    const byId = Object.fromEntries(
      buildStatusBar({
        config: { ...base, agentBackend: "codex" },
        usage,
        contextWindow: 200_000,
      }).map((s) => [s.id, s])
    )
    expect(byId.ctx.text).toContain("% ctx")
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
    expect(byId.model.text).toBe("claude-sonnet-5")
  })

  it("sizes the ctx segment against the per-model window override", () => {
    // 100k prompt tokens; model "claude-x" → 128k pattern fallback = 78%, but a
    // 1M catalog override makes it 10%.
    const ctxUsage: UsageInfo = { inputTokens: 100_000 }
    const fallback = buildStatusBar({ config: base, usage: ctxUsage })
    expect(Object.fromEntries(fallback.map((s) => [s.id, s])).ctx.text).toBe("78% ctx")
    const overridden = buildStatusBar({
      config: base,
      usage: ctxUsage,
      contextWindow: 1_000_000,
    })
    expect(Object.fromEntries(overridden.map((s) => [s.id, s])).ctx.text).toBe("10% ctx")
  })

  it("uses current-window input rather than cumulative multi-leg billing in ctx", () => {
    const segs = buildStatusBar({
      config: base,
      usage: {
        inputTokens: 423_000,
        contextInputTokens: 96_000,
        cacheReadInputTokens: 90_000,
      },
      contextWindow: 1_000_000,
    })
    expect(Object.fromEntries(segs.map((s) => [s.id, s])).ctx.text).toBe("19% ctx")
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

  it("shows picked→effective when the backend can't enforce the picked mode", () => {
    // An `a2a` transport has no client-side approval loop; the manager clamps
    // bypass to `default` before the agent sees it. A footer still reading
    // `bypassPermissions` would be advertising guardrails-off on a session that
    // still asks.
    const cfg: ResolvedConfig = {
      ...base,
      permissionMode: "bypassPermissions",
      statusBar: { theme: "mono", segments: ["mode"] },
    }
    const segs = buildStatusBar({
      config: cfg,
      capabilities: {
        backend: "remote",
        builtin: false,
        protocol: "a2a",
        features: {} as never,
      },
    })
    expect(segs[0].text).toBe("⚠ bypassPermissions→default")
    expect(segs[0].color).toBe("yellow")
  })

  it("goes loud for a clamp even when the picked mode is not danger-tier", () => {
    const cfg: ResolvedConfig = {
      ...base,
      permissionMode: "acceptEdits",
      statusBar: { theme: "mono", segments: ["mode"] },
    }
    const segs = buildStatusBar({
      config: cfg,
      capabilities: { backend: "remote", builtin: false, protocol: "http", features: {} as never },
    })
    expect(segs[0].text).toBe("acceptEdits→default")
    expect(segs[0].color).toBe("yellow")
  })

  it("keeps the plain mode when the backend enforces it", () => {
    const cfg: ResolvedConfig = {
      ...base,
      permissionMode: "acceptEdits",
      statusBar: { theme: "mono", segments: ["mode"] },
    }
    const segs = buildStatusBar({
      config: cfg,
      capabilities: {
        backend: "codex-app-server",
        builtin: false,
        protocol: "codex-app-server",
        features: {} as never,
      },
    })
    expect(segs[0].text).toBe("acceptEdits")
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
    expect(segs[0].text).toBe("⚡ 50% · 1.0k reused")
  })

  it("hides unreported cache telemetry but shows an explicit zero hit rate", () => {
    expect(
      buildStatusBar({
        config: withSB({ segments: ["cache"] }),
        usage: { inputTokens: 1000 },
      })
    ).toEqual([])
    expect(
      buildStatusBar({
        config: withSB({ segments: ["cache"] }),
        usage: { inputTokens: 1000, cacheReadInputTokens: 0 },
      })[0].text
    ).toBe("⚡ 0%")
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

describe("fitStatusSegments", () => {
  const seg = (id: StatusSegmentView["id"], text: string): StatusSegmentView => ({ id, text })
  // model(7) mode(4) ctx(6) tokens(7) git(5) cost(5) → joined with " · " (3 each).
  const segs: StatusSegmentView[] = [
    seg("model", "sonnet4"),
    seg("mode", "auto"),
    seg("ctx", "23%ctx"),
    seg("tokens", "12k tok"),
    seg("git", "⎇ dev"),
    seg("cost", "$0.02"),
  ]

  it("keeps everything and is not truncated when it fits (wide terminal)", () => {
    const out = fitStatusSegments(segs, 200)
    expect(out.truncated).toBe(false)
    expect(out.segments).toEqual(segs)
  })

  it("drops cost then git first on a narrow terminal", () => {
    const out = fitStatusSegments(segs, 40)
    expect(out.truncated).toBe(true)
    const ids = out.segments.map((s) => s.id)
    expect(ids).not.toContain("cost")
    expect(ids).not.toContain("git")
    // The identity segments survive.
    expect(ids).toContain("model")
    expect(ids).toContain("mode")
    // Survivors keep their original order.
    expect(ids).toEqual(
      [...ids].sort((a, b) => segs.findIndex((s) => s.id === a) - segs.findIndex((s) => s.id === b))
    )
  })

  it("keeps the single highest-priority segment when extremely narrow", () => {
    const out = fitStatusSegments(segs, 6)
    expect(out.truncated).toBe(true)
    expect(out.segments.map((s) => s.id)).toEqual(["model"])
    expect(out.segments[0].text).toBe("son…")
  })

  it("truncates one long CJK-aware segment instead of wrapping", () => {
    const out = fitStatusSegments([seg("model", "deepseek-模型名称")], 10)
    expect(out.truncated).toBe(true)
    expect(stringWidth(out.segments[0].text)).toBeLessThanOrEqual(8)
  })

  it("returns nothing for non-positive columns", () => {
    expect(fitStatusSegments(segs, 0)).toEqual({ segments: [], truncated: false })
  })

  it("never exceeds the column budget with the ellipsis marker", () => {
    const out = fitStatusSegments(segs, 30)
    let w = 0
    out.segments.forEach((s, i) => {
      w += s.text.length + (i > 0 ? 3 : 0)
    })
    expect(w + (out.truncated ? 2 : 0)).toBeLessThanOrEqual(30)
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
