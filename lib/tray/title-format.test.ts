import { localDay } from "@/lib/usage/session-analytics"
import type { UsageGlanceBucket } from "@/lib/usage/usage-glance"

import {
  DEFAULT_TRAY_TITLE_FIELDS,
  formatTrayTitle,
  legacyTitleFields,
  normalizeTitleFields,
  titleFieldKey,
  titleNeedsQuota,
  titleNeedsUsage,
  TRAY_TITLE_MAX_FIELDS,
  type TrayTitleData,
  type TrayTitleField,
  type TrayTitleLabels,
} from "./title-format"

// Local noon, so day arithmetic never straddles midnight in any timezone.
const NOW = new Date(2026, 9, 11, 12).getTime()

function dayAgo(back: number): string {
  const d = new Date(NOW)
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 12).getTime())
}

function bucket(back: number, over: Partial<UsageGlanceBucket> = {}): UsageGlanceBucket {
  return {
    day: dayAgo(back),
    tokens: 1_000_000,
    knownCostUsd: 1,
    turns: 2,
    unpricedTurns: 0,
    ...over,
  }
}

const LABELS: TrayTitleLabels = {
  usage: (period, value) => `${period.toUpperCase()} ${value}`,
  running: (count) => `▶${count}`,
  awaiting: (count) => `⚑${count}`,
  quota: (pct) => `Q ${pct}%`,
  budget: (pct) => `B ${pct}%`,
}

function data(over: Partial<TrayTitleData> = {}): TrayTitleData {
  return { daily: [], fleet: null, quotaUsedPct: null, budgetRatio: null, now: NOW, ...over }
}

describe("normalizeTitleFields", () => {
  it("is null for anything that is not a list, which means migrate", () => {
    expect(normalizeTitleFields(undefined)).toBeNull()
    expect(normalizeTitleFields(null)).toBeNull()
    expect(normalizeTitleFields({ kind: "quota" })).toBeNull()
  })

  it("keeps an empty list: the user cleared the title", () => {
    expect(normalizeTitleFields([])).toEqual([])
  })

  it("drops unknown and malformed fields and keeps the rest in order", () => {
    expect(
      normalizeTitleFields([
        { kind: "running" },
        { kind: "usage", period: "1d", metric: "tokens" },
        { kind: "usage", period: "1y", metric: "tokens" },
        { kind: "usage", period: "7d", metric: "joules" },
        { kind: "weather" },
        "quota",
        null,
        { kind: "quota", extra: true },
      ])
    ).toEqual([
      { kind: "running" },
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "quota" },
    ])
  })

  it("keeps the first of two identical fields", () => {
    expect(
      normalizeTitleFields([
        { kind: "usage", period: "7d", metric: "spend" },
        { kind: "awaiting" },
        { kind: "usage", period: "7d", metric: "spend" },
        { kind: "awaiting" },
        { kind: "usage", period: "7d", metric: "tokens" },
      ])
    ).toEqual([
      { kind: "usage", period: "7d", metric: "spend" },
      { kind: "awaiting" },
      { kind: "usage", period: "7d", metric: "tokens" },
    ])
  })

  it("caps the list", () => {
    const many: TrayTitleField[] = [
      { kind: "running" },
      { kind: "awaiting" },
      { kind: "quota" },
      { kind: "budget" },
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "usage", period: "7d", metric: "tokens" },
      { kind: "usage", period: "30d", metric: "tokens" },
    ]
    expect(normalizeTitleFields(many)).toHaveLength(TRAY_TITLE_MAX_FIELDS)
  })
})

describe("titleFieldKey", () => {
  it("tells usage windows and metrics apart and names the rest by kind", () => {
    expect(titleFieldKey({ kind: "usage", period: "1d", metric: "spend" })).toBe("usage:1d:spend")
    expect(titleFieldKey({ kind: "running" })).toBe("running")
  })
})

describe("legacyTitleFields", () => {
  it.each([
    [{ usageMetric: "quota", usagePeriod: "today" }, [{ kind: "quota" }]],
    [{ usageMetric: "budget", usagePeriod: "7d" }, [{ kind: "budget" }]],
    [
      { usageMetric: "spend", usagePeriod: "today" },
      [{ kind: "usage", period: "1d", metric: "spend" }],
    ],
    [
      { usageMetric: "tokens", usagePeriod: "7d" },
      [{ kind: "usage", period: "7d", metric: "tokens" }],
    ],
    [
      { usageMetric: "spend", usagePeriod: "30d" },
      [{ kind: "usage", period: "30d", metric: "spend" }],
    ],
    [
      { usageMetric: "spend", usagePeriod: "month" },
      [{ kind: "usage", period: "30d", metric: "spend" }],
    ],
    [
      { usageMetric: "tokens", usagePeriod: "90d" },
      [{ kind: "usage", period: "30d", metric: "tokens" }],
    ],
  ] as const)("migrates %j", (display, expected) => {
    expect(legacyTitleFields(display)).toEqual(expected)
  })
})

describe("titleNeeds*", () => {
  it("names the feeds a title reads", () => {
    expect(titleNeedsQuota(DEFAULT_TRAY_TITLE_FIELDS)).toBe(false)
    expect(titleNeedsUsage(DEFAULT_TRAY_TITLE_FIELDS)).toBe(true)
    expect(titleNeedsQuota([{ kind: "quota" }])).toBe(true)
    expect(titleNeedsUsage([{ kind: "quota" }, { kind: "running" }])).toBe(false)
  })
})

describe("formatTrayTitle", () => {
  it("joins every field that has something to say, in order", () => {
    const fields: TrayTitleField[] = [
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "usage", period: "7d", metric: "tokens" },
      { kind: "running" },
      { kind: "awaiting" },
      { kind: "quota" },
      { kind: "budget" },
    ]
    const daily = [bucket(0, { tokens: 103_300_000 }), bucket(3, { tokens: 12_500_000_000 })]
    expect(
      formatTrayTitle(
        fields,
        data({
          daily,
          fleet: { working: 2, awaiting: 1 },
          quotaUsedPct: 81.6,
          budgetRatio: 0.644,
        }),
        LABELS
      )
    ).toBe("1D 103.3M · 7D 12.6B · ▶2 · ⚑1 · Q 82% · B 64%")
  })

  it("sums each window over its own local days", () => {
    const daily = [bucket(0), bucket(6), bucket(7), bucket(29), bucket(30)]
    const fields: TrayTitleField[] = [
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "usage", period: "7d", metric: "tokens" },
      { kind: "usage", period: "30d", metric: "tokens" },
    ]
    expect(formatTrayTitle(fields, data({ daily }), LABELS)).toBe("1D 1M · 7D 2M · 30D 4M")
  })

  it("leaves out a window with no turns rather than showing zero", () => {
    const fields: TrayTitleField[] = [
      { kind: "usage", period: "1d", metric: "tokens" },
      { kind: "usage", period: "7d", metric: "tokens" },
    ]
    expect(formatTrayTitle(fields, data({ daily: [bucket(2)] }), LABELS)).toBe("7D 1M")
  })

  it("marks spend with unpriced turns as a lower bound", () => {
    const fields: TrayTitleField[] = [{ kind: "usage", period: "1d", metric: "spend" }]
    expect(
      formatTrayTitle(
        fields,
        data({ daily: [bucket(0, { knownCostUsd: 4.2, turns: 5, unpricedTurns: 2 })] }),
        LABELS
      )
    ).toBe("1D ≥$4.2")
    expect(
      formatTrayTitle(fields, data({ daily: [bucket(0, { knownCostUsd: 4.2 })] }), LABELS)
    ).toBe("1D $4.2")
  })

  it("leaves out spend when no turn had a price", () => {
    const fields: TrayTitleField[] = [{ kind: "usage", period: "1d", metric: "spend" }]
    expect(
      formatTrayTitle(
        fields,
        data({ daily: [bucket(0, { knownCostUsd: 0, turns: 3, unpricedTurns: 3 })] }),
        LABELS
      )
    ).toBeNull()
  })

  it("leaves out counts of zero and Fleet where there is none", () => {
    const fields: TrayTitleField[] = [{ kind: "running" }, { kind: "awaiting" }]
    expect(formatTrayTitle(fields, data({ fleet: { working: 0, awaiting: 3 } }), LABELS)).toBe("⚑3")
    expect(formatTrayTitle(fields, data({ fleet: null }), LABELS)).toBeNull()
  })

  it("leaves out quota and budget with no reading", () => {
    expect(formatTrayTitle([{ kind: "quota" }, { kind: "budget" }], data(), LABELS)).toBeNull()
    expect(
      formatTrayTitle([{ kind: "quota" }], data({ quotaUsedPct: Number.NaN }), LABELS)
    ).toBeNull()
  })

  it("never shows a negative share", () => {
    expect(formatTrayTitle([{ kind: "quota" }], data({ quotaUsedPct: -3 }), LABELS)).toBe("Q 0%")
  })

  it("is null with no usage feed and no fields", () => {
    expect(
      formatTrayTitle(
        [{ kind: "usage", period: "1d", metric: "tokens" }],
        data({ daily: null }),
        LABELS
      )
    ).toBeNull()
    expect(formatTrayTitle([], data(), LABELS)).toBeNull()
  })
})
