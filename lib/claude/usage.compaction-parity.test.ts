/**
 * Cross-boundary parity guard.
 *
 * The sidecar cannot import `lib/`, so `sidecar/dispatch/compaction.mjs`
 * hand-mirrors the context-window table + auto-compact fraction + default
 * window from `lib/claude/usage.ts`. This test imports BOTH modules (it lives
 * under `lib/`, not `/sidecar/`, so Jest runs it; `compaction.mjs` has zero
 * imports so it transforms cleanly) and asserts they agree across a model-id
 * matrix. If anyone edits one window table without the other, this goes red.
 */
import {
  AUTO_COMPACT_FRACTION,
  DEFAULT_CONTEXT_WINDOW,
  getModelContextWindow,
} from "@/lib/claude/usage"
import {
  AUTO_COMPACT_FRACTION as SIDECAR_FRACTION,
  DEFAULT_CONTEXT_WINDOW as SIDECAR_DEFAULT,
  getContextWindow,
} from "../../sidecar/dispatch/compaction.mjs"

// Every model family the AI-SDK path can drive, plus the explicit build markers
// and the unknown/undefined fall-through. First-match-wins ordering must agree
// on every row for the indicator (renderer) and the trigger (sidecar) to line up.
const MODEL_MATRIX = [
  "claude-opus-4-8[1m]",
  "claude-sonnet-4-6.1m",
  "claude-sonnet-4-5-1m",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-opus-4-1",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "claude-3-5-haiku",
  "gpt-4o",
  "gpt-4.1",
  "o3",
  "o1",
  "gemini-2.5-pro",
  "gemini-1.5-flash",
  "deepseek-chat",
  "deepseek-reasoner",
  "some-unknown-local-model",
]

describe("compaction window-table parity (lib ↔ sidecar)", () => {
  it("agrees on the auto-compact fraction", () => {
    expect(SIDECAR_FRACTION).toBe(AUTO_COMPACT_FRACTION)
  })

  it("agrees on the default window for unknown / undefined model ids", () => {
    expect(SIDECAR_DEFAULT).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(getContextWindow(undefined)).toBe(getModelContextWindow(undefined))
    expect(getContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it.each(MODEL_MATRIX)("agrees on the window for %s", (modelId) => {
    expect(getContextWindow(modelId)).toBe(getModelContextWindow(modelId))
  })

  it("reflects the reconciled 128k floor for default + DeepSeek", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000)
    expect(getModelContextWindow("deepseek-chat")).toBe(128_000)
    expect(getContextWindow("deepseek-reasoner")).toBe(128_000)
  })
})
