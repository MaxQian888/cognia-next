import cjkWords from "@web/content/generated/cjk-words.json"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { buildCjkWords, collectCjkTitles, normalizeTitle, wordStarts } from "./cjk-words"

const segmenter = new Intl.Segmenter("zh", { granularity: "word" })

describe("normalizeTitle", () => {
  it("trims and collapses whitespace as SplitReveal does", () => {
    expect(normalizeTitle("  开放 \n AI  Agent ")).toBe("开放 AI Agent")
  })
})

describe("collectCjkTitles", () => {
  it("collects CJK strings under title keys at any depth, arrays included", () => {
    const copy = {
      title: "在桌面开工",
      body: "不是标题",
      nested: { items: [{ title: "任何地方" }, { title: "Latin only" }], label: "标签" },
    }
    expect(collectCjkTitles(copy)).toEqual(["任何地方", "在桌面开工"])
  })

  it("collects nothing from the English copy", () => {
    expect(collectCjkTitles(en)).toEqual([])
  })
})

describe("wordStarts", () => {
  it("lists the offsets where each word after the first starts", () => {
    expect(wordStarts("在任何地方", segmenter)).toEqual([1, 3])
  })

  it("merges the single characters ICU leaves unsegmented into runs of up to four", () => {
    // ICU: 一个|工作|空间|，|四|个|模|块|，… — 模块 must not break apart.
    const text = "一个工作空间，四个模块，一份"
    expect(wordStarts(text, segmenter)).toEqual([2, 4, 6, 7, 11, 12])
  })

  it("never merges a single character into a multi-character word or across punctuation", () => {
    // ICU: 每|个|入口|走|同|一套 — singles merge (每个, 走同), words stay whole.
    expect(wordStarts("每个入口走同一套", segmenter)).toEqual([2, 4, 6])
    expect(wordStarts("四，个", segmenter)).toEqual([1, 2])
  })
})

describe("content/generated/cjk-words.json", () => {
  it("matches the current Chinese copy (regenerate with node web/scripts/build-cjk-words.mjs)", () => {
    expect(cjkWords).toEqual(buildCjkWords(zh, segmenter))
  })

  it("covers every Chinese headline the site sets", () => {
    for (const title of [zh.home.hero.title, zh.surfaces.header.title, zh.product.header.title]) {
      expect(cjkWords).toHaveProperty([normalizeTitle(title)])
    }
  })
})
