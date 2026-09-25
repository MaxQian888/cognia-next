import {
  MAX_LABELS_PER_MESSAGE,
  MAX_LABELS_PER_PLUGIN,
  capInboundLabels,
  normalizeInboundLabels,
  readInboundLabels,
  severityForScore,
} from "./inbound-labels"

describe("normalizeInboundLabels", () => {
  it("accepts well-formed labels and stamps source + time", () => {
    expect(
      normalizeInboundLabels(
        [{ key: "spam", score: 0.97, label: "Spam", note: "laya spam=0.97 (observe)" }],
        "cognia-laya-guard",
        123
      )
    ).toEqual([
      {
        key: "spam",
        score: 0.97,
        severity: "high",
        label: "Spam",
        note: "laya spam=0.97 (observe)",
        source: "cognia-laya-guard",
        at: 123,
      },
    ])
  })

  it("derives severity, defaults the label to the key and keeps a label key", () => {
    const [warn, info] = normalizeInboundLabels(
      [
        { key: "toxic", score: 0.7, labelKey: "labels.toxic" },
        { key: "promo", score: 0.2, severity: "bogus" },
      ],
      "p",
      1
    )
    expect(warn).toMatchObject({ severity: "warn", label: "toxic", labelKey: "labels.toxic" })
    expect(info).toMatchObject({ severity: "info", label: "promo" })
    expect(severityForScore(0.9)).toBe("high")
  })

  it("drops malformed entries and duplicates, and redacts notes", () => {
    const labels = normalizeInboundLabels(
      [
        null,
        "spam",
        { key: "Spam", score: 0.5 },
        { key: "spam", score: 1.2 },
        { key: "spam", score: Number.NaN },
        { key: "threat", score: 0.8, note: "call 13812345678" },
        { key: "threat", score: 0.9 },
      ],
      "p",
      1
    )
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ key: "threat", score: 0.8 })
    expect(labels[0].note).toMatch(/^call <PHONE_\d{3,}>$/)
    expect(normalizeInboundLabels({ key: "spam" }, "p", 1)).toEqual([])
  })

  it("caps per plugin and per message", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, score: 0.5 }))
    const one = normalizeInboundLabels(many, "a", 1)
    expect(one).toHaveLength(MAX_LABELS_PER_PLUGIN)
    const all = capInboundLabels([
      ...one,
      ...normalizeInboundLabels(many, "b", 1),
      ...normalizeInboundLabels(many, "c", 1),
    ])
    expect(all).toHaveLength(MAX_LABELS_PER_MESSAGE)
  })
})

describe("readInboundLabels", () => {
  it("keeps only persisted-shape labels", () => {
    const good = { key: "spam", score: 0.9, severity: "high", label: "Spam", source: "p", at: 1 }
    expect(readInboundLabels([good, { key: "x" }, 3])).toEqual([good])
    expect(readInboundLabels(undefined)).toEqual([])
  })
})
