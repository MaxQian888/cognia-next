import type { CapturedPage } from "../panel-state"
import { DRAFT_TTL_MS, isCapturedPage, isEmptyDraft, parseDraft, type PanelDraft } from "./drafts"

const PAGE: CapturedPage = {
  tabId: 1,
  title: "A",
  url: "https://a.test/",
  rawUrl: "https://a.test/?q",
  selection: { text: "s", truncated: false },
  readableText: null,
  capturedAt: 5,
  strippedQuery: true,
}

function draft(overrides: Partial<PanelDraft> = {}): PanelDraft {
  return {
    v: 1,
    captured: PAGE,
    extraPages: [],
    scope: "auto",
    instruction: "sum",
    workspaceId: "w",
    targetId: null,
    targetParams: {},
    includeFullUrl: false,
    droppedAttachments: 0,
    savedAt: 1_000,
    ...overrides,
  }
}

describe("parseDraft", () => {
  it("round-trips a draft", () => {
    expect(parseDraft(JSON.parse(JSON.stringify(draft())), 2_000)).toEqual(draft())
  })

  it("drops stale, future, malformed and foreign values", () => {
    expect(parseDraft(draft(), 1_000 + DRAFT_TTL_MS + 1)).toBeNull()
    expect(parseDraft(draft({ savedAt: 10_000_000 }), 1_000)).toBeNull()
    expect(parseDraft({ ...draft(), v: 2 }, 2_000)).toBeNull()
    expect(parseDraft({ ...draft(), captured: { tabId: "x" } }, 2_000)).toBeNull()
    expect(parseDraft("draft", 2_000)).toBeNull()
  })

  it("repairs the parts it can", () => {
    const parsed = parseDraft(
      {
        ...draft(),
        scope: "everything",
        extraPages: [PAGE, { nope: true }],
        targetParams: { a: "1", b: 2 },
        droppedAttachments: -3,
        instruction: 7,
      },
      2_000
    )
    expect(parsed).toMatchObject({
      scope: "auto",
      extraPages: [PAGE],
      targetParams: { a: "1" },
      droppedAttachments: 0,
      instruction: "",
    })
  })
})

describe("helpers", () => {
  it("recognizes pages and empty drafts", () => {
    expect(isCapturedPage(PAGE)).toBe(true)
    expect(isCapturedPage({ ...PAGE, article: { text: 1 } })).toBe(false)
    expect(isEmptyDraft({ captured: null, extraPages: [], instruction: "  " })).toBe(true)
    expect(isEmptyDraft({ captured: null, extraPages: [], instruction: "x" })).toBe(false)
  })
})
