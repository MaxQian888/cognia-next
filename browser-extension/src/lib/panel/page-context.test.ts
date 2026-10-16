import { BROWSER_CONTEXT_LIMITS, type BrowserCompanionFeature } from "@cognia/companion-client"

import type { PageCapture } from "../capture/page-capture"
import type { CapturedPage } from "../panel-state"
import {
  buildPageContext,
  checkPages,
  contextContentBytes,
  editableText,
  toCapturedPage,
  withEditedText,
  withoutUnsupported,
} from "./page-context"

const ALL: BrowserCompanionFeature[] = [
  "article",
  "markdown-selection",
  "metadata",
  "transcript",
  "link-image",
]

function capture(overrides: Partial<PageCapture> = {}): PageCapture {
  return {
    title: "Title",
    url: "https://a.test/x",
    selection: { text: "plain words", markdown: "**plain** words" },
    readableText: "all the words",
    readableCharacterCount: 13,
    article: { markdown: "# Heading\n\nbody", characterCount: 15 },
    metadata: { byline: "Ann", siteName: "A" },
    isPdf: false,
    ...overrides,
  }
}

function page(input: Partial<Parameters<typeof toCapturedPage>[0]> = {}): CapturedPage {
  return toCapturedPage(
    {
      tabId: 3,
      tabTitle: "Tab",
      normalizedUrl: "https://a.test/x",
      rawUrl: "https://a.test/x?q=1",
      strippedQuery: true,
      capture: capture(),
      transcript: null,
      capturedAt: 10,
      ...input,
    },
    BROWSER_CONTEXT_LIMITS
  )
}

describe("toCapturedPage", () => {
  it("keeps every part, clipped to the Host's ceilings", () => {
    const limits = { ...BROWSER_CONTEXT_LIMITS, articleBytes: 4, transcriptBytes: 3 }
    const captured = toCapturedPage(
      {
        tabId: 3,
        tabTitle: "Tab",
        normalizedUrl: "https://a.test/x",
        rawUrl: "https://a.test/x",
        strippedQuery: false,
        capture: capture({ title: "" }),
        transcript: { status: "available", text: "[0:00] hi", truncated: false, language: "en" },
        link: { url: "https://b.test/" },
        capturedAt: 10,
      },
      limits
    )
    expect(captured.title).toBe("Tab")
    expect(captured.selection).toEqual({
      text: "plain words",
      truncated: false,
      markdown: "**plain** words",
    })
    expect(captured.article).toEqual({ text: "# He", truncated: true, originalCharacterCount: 15 })
    expect(captured.transcript).toEqual({
      status: "available",
      text: "[0:",
      truncated: true,
      language: "en",
    })
    expect(captured.metadata).toEqual({ byline: "Ann", siteName: "A" })
    expect(captured.link).toEqual({ url: "https://b.test/" })
    expect(captured.isPdf).toBe(false)
  })

  it("keeps an unavailable transcript as the stated outcome", () => {
    expect(
      page({ transcript: { status: "unavailable", reason: "no_captions" } }).transcript
    ).toEqual({
      status: "unavailable",
      reason: "no_captions",
    })
  })

  it("drops empty metadata and absent parts", () => {
    const captured = page({
      capture: capture({ metadata: {}, selection: null, article: null, readableText: null }),
    })
    expect(captured).toMatchObject({
      metadata: null,
      selection: null,
      article: null,
      readableText: null,
    })
  })
})

describe("buildPageContext", () => {
  it("sends the article and every optional field to a Host that lists them", () => {
    const context = buildPageContext(
      {
        ...page({ transcript: { status: "unavailable", reason: "not_a_video" } }),
        link: { url: "https://b.test/", text: "B" },
        image: { url: "https://c.test/i.png" },
      },
      "article",
      ALL
    )
    expect(context).toEqual({
      schemaVersion: 1,
      captureMode: "article",
      url: "https://a.test/x",
      title: "Title",
      capturedAt: 10,
      selection: { text: "**plain** words", truncated: false, format: "markdown" },
      article: {
        text: "# Heading\n\nbody",
        truncated: false,
        originalCharacterCount: 15,
        format: "markdown",
      },
      metadata: { byline: "Ann", siteName: "A" },
      transcript: { status: "unavailable", reason: "not_a_video" },
      link: { url: "https://b.test/", text: "B" },
      image: { url: "https://c.test/i.png" },
    })
  })

  it("gives an older Host only the shape it always had", () => {
    const context = buildPageContext({ ...page(), link: { url: "https://b.test/" } }, "article", [])
    expect(context).toEqual({
      schemaVersion: 1,
      captureMode: "readable-page",
      url: "https://a.test/x",
      title: "Title",
      capturedAt: 10,
      selection: { text: "plain words", truncated: false },
      readableText: { text: "all the words", truncated: false, originalCharacterCount: 13 },
    })
  })

  it("sends no content in metadata mode", () => {
    const context = buildPageContext({ ...page(), selection: null }, "auto", ALL)
    expect(context.captureMode).toBe("metadata")
    expect(context.selection).toBeUndefined()
    expect(context.readableText).toBeUndefined()
    expect(context.metadata).toBeDefined()
  })
})

describe("editing", () => {
  it("edits the text the mode sends, both forms of a selection", () => {
    const captured = page()
    expect(editableText(captured, "selection")).toBe("**plain** words")
    const edited = withEditedText(captured, "selection", "shorter")
    expect(edited.selection).toEqual({ text: "shorter", truncated: false, markdown: "shorter" })
    expect(withEditedText(captured, "article", "x").article?.text).toBe("x")
    expect(withEditedText(captured, "readable-page", "y").readableText?.text).toBe("y")
    expect(withEditedText(captured, "metadata", "z")).toBe(captured)
    expect(editableText(captured, "metadata")).toBeNull()
  })
})

describe("budgets", () => {
  it("counts content bytes as the Host does and checks page count and total", () => {
    const one = buildPageContext(page(), "page", ALL)
    expect(contextContentBytes(one)).toBe(
      new TextEncoder().encode("**plain** words" + "all the words").byteLength
    )
    const limits = { ...BROWSER_CONTEXT_LIMITS, maxPages: 2, totalContextBytes: 50 }
    expect(checkPages([one], limits)).toEqual({ ok: true, totalBytes: 28 })
    expect(checkPages([one, one, one], limits)).toMatchObject({
      ok: false,
      reason: "too_many_pages",
    })
    expect(checkPages([one, one], { ...limits, totalContextBytes: 40 })).toMatchObject({
      ok: false,
      reason: "over_budget",
    })
  })
})

describe("withoutUnsupported", () => {
  it("drops what an older Host would not read, keeping the rest", () => {
    const captured = {
      ...page({ transcript: { status: "unavailable", reason: "no_captions" } }),
      link: { url: "https://b.test/" },
    }
    const stripped = withoutUnsupported(captured, ["metadata"])
    expect(stripped.selection).toEqual({ text: "plain words", truncated: false })
    expect(stripped).toMatchObject({ article: null, transcript: null, link: null, image: null })
    expect(stripped.metadata).toEqual({ byline: "Ann", siteName: "A" })
    expect(withoutUnsupported(captured, ALL)).toEqual(captured)
  })
})
