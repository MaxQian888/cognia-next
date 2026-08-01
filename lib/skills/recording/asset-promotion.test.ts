import {
  ASSET_PREFIX,
  assetFileName,
  buildResourceDrafts,
  injectImageLinks,
  MAX_PROMOTED_SCREENSHOTS,
  planPromotion,
  type PromotedAsset,
} from "./asset-promotion"
import type { RecordedStepView } from "./step-model"

function view(patch: Partial<RecordedStepView> = {}): RecordedStepView {
  return {
    seq: 1,
    captured: { seq: 1, tsMs: 0, kind: "click", assetId: "asset-1" },
    manual: false,
    excluded: false,
    intent: null,
    verify: null,
    screenshotSelected: true,
    needsIntent: false,
    ...patch,
  }
}

describe("assetFileName", () => {
  it("zero-pads to three digits so a directory listing sorts past 99", () => {
    expect(assetFileName(0)).toBe(`${ASSET_PREFIX}-001.png`)
    expect(assetFileName(9)).toBe(`${ASSET_PREFIX}-010.png`)
    expect(assetFileName(99)).toBe(`${ASSET_PREFIX}-100.png`)
  })
})

describe("planPromotion", () => {
  it("plans one asset per selected, included step, in timeline order", () => {
    const { assets, skipped } = planPromotion([
      view({ seq: 1, captured: { seq: 1, tsMs: 0, kind: "click", assetId: "a" } }),
      view({ seq: 2, captured: { seq: 2, tsMs: 1, kind: "click", assetId: "b" } }),
    ])
    expect(assets).toEqual([
      {
        seq: 1,
        assetId: "a",
        name: `${ASSET_PREFIX}-001.png`,
        path: `assets/${ASSET_PREFIX}-001.png`,
      },
      {
        seq: 2,
        assetId: "b",
        name: `${ASSET_PREFIX}-002.png`,
        path: `assets/${ASSET_PREFIX}-002.png`,
      },
    ])
    expect(skipped).toBe(0)
  })

  it("skips excluded steps, and does not consume a filename for them", () => {
    // The numbering follows the promoted assets, not the original seqs —
    // otherwise excluding step 1 would leave a gap at `-001`.
    const { assets } = planPromotion([
      view({ seq: 1, excluded: true, captured: { seq: 1, tsMs: 0, kind: "click", assetId: "a" } }),
      view({ seq: 2, captured: { seq: 2, tsMs: 1, kind: "click", assetId: "b" } }),
    ])
    expect(assets).toEqual([
      {
        seq: 2,
        assetId: "b",
        name: `${ASSET_PREFIX}-001.png`,
        path: `assets/${ASSET_PREFIX}-001.png`,
      },
    ])
  })

  it("skips deselected screenshots and steps with no frame", () => {
    const { assets } = planPromotion([
      view({ seq: 1, screenshotSelected: false }),
      view({ seq: 2, captured: { seq: 2, tsMs: 1, kind: "click" } }),
      view({ seq: 3, manual: true, captured: null }),
    ])
    expect(assets).toEqual([])
  })

  it("caps the count and reports what was left out", () => {
    const many = Array.from({ length: MAX_PROMOTED_SCREENSHOTS + 3 }, (_, i) =>
      view({ seq: i + 1, captured: { seq: i + 1, tsMs: i, kind: "click", assetId: `a${i}` } })
    )
    const { assets, skipped } = planPromotion(many)
    expect(assets).toHaveLength(MAX_PROMOTED_SCREENSHOTS)
    expect(skipped).toBe(3)
  })

  it("honours an explicit lower cap", () => {
    const { assets, skipped } = planPromotion([view({ seq: 1 }), view({ seq: 2 })], 1)
    expect(assets).toHaveLength(1)
    expect(skipped).toBe(1)
  })
})

describe("buildResourceDrafts", () => {
  const assets: PromotedAsset[] = [
    { seq: 1, assetId: "a", name: "n1.png", path: "assets/n1.png" },
    { seq: 2, assetId: "b", name: "n2.png", path: "assets/n2.png" },
  ]

  it("pairs each asset with its bytes as a base64 png resource", () => {
    const drafts = buildResourceDrafts(
      assets,
      new Map([
        ["a", "AAAA"],
        ["b", "BBBB"],
      ])
    )
    expect(drafts).toEqual([
      {
        kind: "asset",
        name: "n1.png",
        path: "assets/n1.png",
        content: "AAAA",
        encoding: "base64",
        mimeType: "image/png",
      },
      expect.objectContaining({ path: "assets/n2.png", content: "BBBB" }),
    ])
  })

  it("drops a frame it could not read rather than writing it empty", () => {
    // An `<img>` pointing at a zero-byte resource is worse than no image.
    const drafts = buildResourceDrafts(assets, new Map([["b", "BBBB"]]))
    expect(drafts.map((d) => d.path)).toEqual(["assets/n2.png"])
  })

  it("returns nothing when no bytes were fetched", () => {
    expect(buildResourceDrafts(assets, new Map())).toEqual([])
  })
})

describe("injectImageLinks", () => {
  const alt = (i: number) => `Step ${i + 1}`
  const body = `## Steps

1. Open billing
2. Click Export

## Verify

1. The file downloads.`

  it("puts each link under the step it illustrates", () => {
    const out = injectImageLinks(
      body,
      [
        { seq: 1, assetId: "a", name: "n1.png", path: "assets/n1.png" },
        { seq: 2, assetId: "b", name: "n2.png", path: "assets/n2.png" },
      ],
      alt
    )
    const lines = out.split("\n").filter((l) => l.trim())
    // The three-space continuation indent is what keeps the image inside the
    // list item instead of terminating the ordered list.
    expect(lines).toEqual([
      "## Steps",
      "1. Open billing",
      "   ![Step 1](assets/n1.png)",
      "2. Click Export",
      "   ![Step 2](assets/n2.png)",
      "## Verify",
      "1. The file downloads.",
    ])
  })

  it("never touches numbered lines outside `## Steps`", () => {
    // `## Verify` uses the same numbering for a checklist; an image there would
    // claim a screenshot proves an assertion it was never taken for.
    const out = injectImageLinks(
      body,
      [
        { seq: 1, assetId: "a", name: "n1.png", path: "assets/n1.png" },
        { seq: 2, assetId: "b", name: "n2.png", path: "assets/n2.png" },
        { seq: 3, assetId: "c", name: "n3.png", path: "assets/n3.png" },
      ],
      alt
    )
    expect(out).not.toContain("n3.png")
  })

  it("leaves steps beyond the planned assets alone", () => {
    const out = injectImageLinks(
      body,
      [{ seq: 1, assetId: "a", name: "n1.png", path: "assets/n1.png" }],
      alt
    )
    expect(out).toContain("![Step 1](assets/n1.png)")
    expect(out.match(/!\[/g)).toHaveLength(1)
  })

  it("returns the markdown untouched when nothing was promoted", () => {
    expect(injectImageLinks(body, [], alt)).toBe(body)
  })

  it("preserves the step's own indentation", () => {
    const nested = "## Steps\n\n  1. Indented"
    const out = injectImageLinks(
      nested,
      [{ seq: 1, assetId: "a", name: "n.png", path: "assets/n.png" }],
      alt
    )
    expect(out).toContain("     ![Step 1](assets/n.png)")
  })

  it("matches the heading case-insensitively", () => {
    const out = injectImageLinks(
      "## STEPS\n\n1. Go",
      [{ seq: 1, assetId: "a", name: "n.png", path: "assets/n.png" }],
      alt
    )
    expect(out).toContain("![Step 1](assets/n.png)")
  })
})
