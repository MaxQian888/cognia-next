import type { AppSettings } from "@cognia/agent-config-types"
import { DEFAULT_EVAL_SETTINGS } from "@/types/eval/settings"
import { resolveEvalSettings, EVAL_K_RANGE } from "./settings"

const asSettings = (evalSettings: AppSettings["evalSettings"]): AppSettings =>
  ({ evalSettings }) as AppSettings

describe("resolveEvalSettings", () => {
  it("returns defaults when absent", () => {
    expect(resolveEvalSettings(null)).toEqual(DEFAULT_EVAL_SETTINGS)
    expect(resolveEvalSettings(undefined)).toEqual(DEFAULT_EVAL_SETTINGS)
    expect(resolveEvalSettings({} as AppSettings)).toEqual(DEFAULT_EVAL_SETTINGS)
  })

  it("merges partial overrides over defaults", () => {
    const r = resolveEvalSettings(asSettings({ judgeModel: "gpt-5", defaultK: 3 } as never))
    expect(r.judgeModel).toBe("gpt-5")
    expect(r.defaultK).toBe(3)
    expect(r.defaultScorerIds).toEqual([])
  })

  it("clamps k to the allowed range and rounds", () => {
    expect(resolveEvalSettings(asSettings({ defaultK: 0 } as never)).defaultK).toBe(
      EVAL_K_RANGE.min
    )
    expect(resolveEvalSettings(asSettings({ defaultK: 99 } as never)).defaultK).toBe(
      EVAL_K_RANGE.max
    )
    expect(resolveEvalSettings(asSettings({ defaultK: 2.6 } as never)).defaultK).toBe(3)
    expect(resolveEvalSettings(asSettings({ defaultK: NaN } as never)).defaultK).toBe(
      DEFAULT_EVAL_SETTINGS.defaultK
    )
  })

  it("drops unknown scorer ids", () => {
    const r = resolveEvalSettings(
      asSettings({ defaultScorerIds: ["cost", "redundancy", "judge-task-completion"] } as never)
    )
    expect(r.defaultScorerIds).toEqual(["cost", "judge-task-completion"])
  })

  it("passes through gate + cost guard", () => {
    const r = resolveEvalSettings(
      asSettings({ defaultGate: { minPassAt1: 0.8 }, costWarnUsd: 5 } as never)
    )
    expect(r.defaultGate).toEqual({ minPassAt1: 0.8 })
    expect(r.costWarnUsd).toBe(5)
  })
})

describe("resolveEvalSettings — stored output cap", () => {
  it("defaults to 4096 characters", () => {
    expect(resolveEvalSettings(null).maxStoredOutputChars).toBe(4096)
  })

  it("keeps a valid value, allows 0 to disable, and rounds", () => {
    expect(
      resolveEvalSettings(asSettings({ maxStoredOutputChars: 1000 })).maxStoredOutputChars
    ).toBe(1000)
    expect(resolveEvalSettings(asSettings({ maxStoredOutputChars: 0 })).maxStoredOutputChars).toBe(
      0
    )
    expect(
      resolveEvalSettings(asSettings({ maxStoredOutputChars: 1000.6 })).maxStoredOutputChars
    ).toBe(1001)
  })

  it("clamps out-of-range and non-finite values instead of trusting them", () => {
    // A huge cap would put megabytes of prose per run into IndexedDB.
    expect(
      resolveEvalSettings(asSettings({ maxStoredOutputChars: 10_000_000 })).maxStoredOutputChars
    ).toBe(32_768)
    expect(resolveEvalSettings(asSettings({ maxStoredOutputChars: -5 })).maxStoredOutputChars).toBe(
      0
    )
    expect(
      resolveEvalSettings(asSettings({ maxStoredOutputChars: Number.NaN })).maxStoredOutputChars
    ).toBe(4096)
  })
})
