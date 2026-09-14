import type { RemoteDocRef } from "@/lib/docs-providers"
import {
  createAttachmentCitations,
  DETACHED_BINDING_LIMIT,
  remoteDocCitation,
} from "./attachment-citations"
import type { ContextRef } from "./types"

const PLAN: ContextRef = { kind: "doc", id: "lark:doc_1", label: "Plan", raw: "@lark:doc_1" }
const BUDGET: ContextRef = { kind: "doc", id: "google:g_2", label: "Budget", raw: "@google:g_2" }

const planFile = { name: "Plan.md", type: "text/markdown" }
const budgetFile = { name: "Budget.csv", type: "text/csv" }

function attachment(id: string, file: { name: string; type: string }) {
  return { id, filename: file.name, mediaType: file.type }
}

describe("createAttachmentCitations", () => {
  it("binds an announced file to the id the provider minted for it", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.observe([attachment("a1", planFile)])
    expect(citations.citationOf("a1")).toEqual(PLAN)
    expect(citations.citationsFor([{ id: "a1" }])).toEqual([PLAN])
  })

  it("cites nothing for a file nobody announced", () => {
    const citations = createAttachmentCitations()
    citations.observe([attachment("a1", planFile)])
    expect(citations.citationOf("a1")).toBeUndefined()
    expect(citations.citationsFor([{ id: "a1" }])).toEqual([])
  })

  // The bug this module exists for: removing the chip must take the citation
  // with it, even when the send is later built from the remaining files.
  it("does not cite a document whose chip is no longer among the submitted files", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.expect(budgetFile, BUDGET)
    citations.observe([attachment("a1", planFile), attachment("a2", budgetFile)])
    citations.observe([attachment("a2", budgetFile)])
    expect(citations.citationsFor([{ id: "a2" }])).toEqual([BUDGET])
  })

  // Name matching is only how the id is LEARNED. Once bound, a same-named file
  // the user dropped themselves cannot inherit the citation.
  it("keeps the binding on the exact attachment when a same-named file sits beside it", () => {
    const citations = createAttachmentCitations()
    citations.observe([attachment("mine", planFile)])
    citations.expect(planFile, PLAN)
    citations.observe([attachment("mine", planFile), attachment("doc", planFile)])
    expect(citations.citationOf("doc")).toEqual(PLAN)
    expect(citations.citationOf("mine")).toBeUndefined()
    // Remove the document's chip: the user's own Plan.md cites nothing.
    citations.observe([attachment("mine", planFile)])
    expect(citations.citationsFor([{ id: "mine" }])).toEqual([])
  })

  it("requires the media type to match as well as the name", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.observe([{ id: "a1", filename: "Plan.md", mediaType: "text/plain" }])
    expect(citations.citationOf("a1")).toBeUndefined()
  })

  it("hands each announcement to one attachment only", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.observe([attachment("a1", planFile), attachment("a2", planFile)])
    expect(citations.citationOf("a1")).toEqual(PLAN)
    expect(citations.citationOf("a2")).toBeUndefined()
  })

  it("binds files staged together in one add() in announcement order", () => {
    const citations = createAttachmentCitations()
    const other: ContextRef = { ...PLAN, id: "lark:doc_9", label: "Plan (copy)" }
    citations.expect(planFile, PLAN)
    citations.expect(planFile, other)
    citations.observe([attachment("a1", planFile), attachment("a2", planFile)])
    expect(citations.citationOf("a1")).toEqual(PLAN)
    expect(citations.citationOf("a2")).toEqual(other)
  })

  // An announcement whose add() was refused, or whose file was cleared before
  // anything observed it, must not wait around for a later same-named file.
  it("drops an announcement no new attachment matched", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.observe([attachment("a1", budgetFile)])
    citations.observe([attachment("a1", budgetFile), attachment("a2", planFile)])
    expect(citations.citationOf("a2")).toBeUndefined()
  })

  it("keeps an announcement through an observation that saw only removals", () => {
    const citations = createAttachmentCitations()
    citations.observe([attachment("a1", budgetFile)])
    citations.expect(planFile, PLAN)
    citations.observe([])
    citations.observe([attachment("a2", planFile)])
    expect(citations.citationOf("a2")).toEqual(PLAN)
  })

  it("tolerates observing the same list twice (StrictMode re-runs effects)", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    const files = [attachment("a1", planFile)]
    citations.observe(files)
    citations.observe(files)
    expect(citations.citationOf("a1")).toEqual(PLAN)
  })

  it("cites the same document once however many times it was staged", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.observe([attachment("a1", planFile)])
    citations.expect(planFile, PLAN)
    citations.observe([attachment("a1", planFile), attachment("a2", planFile)])
    expect(citations.citationsFor([{ id: "a1" }, { id: "a2" }])).toEqual([PLAN])
    // Either copy alone still carries it.
    expect(citations.citationsFor([{ id: "a2" }])).toEqual([PLAN])
  })

  it("follows the submission order", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.expect(budgetFile, BUDGET)
    citations.observe([attachment("a1", planFile), attachment("a2", budgetFile)])
    expect(citations.citationsFor([{ id: "a2" }, { id: "a1" }])).toEqual([BUDGET, PLAN])
  })

  it("does not cite a staged file whose extraction was rejected", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.expect(budgetFile, BUDGET)
    citations.observe([attachment("a1", planFile), attachment("a2", budgetFile)])
    const precomputed = new Map([
      ["a1", { block: null }],
      ["a2", { block: { type: "text", text: "a,b" } }],
    ])
    expect(citations.citationsFor([{ id: "a1" }, { id: "a2" }], precomputed)).toEqual([BUDGET])
  })

  it("ignores submitted files that carry no id", () => {
    const citations = createAttachmentCitations()
    expect(citations.citationsFor([{}])).toEqual([])
  })

  // The send reads a snapshot taken before it awaited anything, so a chip the
  // user removed during the over-length confirmation is still sent — and must
  // still be cited.
  it("still cites a submitted file whose chip was removed after the snapshot", () => {
    const citations = createAttachmentCitations()
    citations.expect(planFile, PLAN)
    citations.observe([attachment("a1", planFile)])
    const snapshot = [{ id: "a1" }]
    citations.observe([])
    expect(citations.citationsFor(snapshot)).toEqual([PLAN])
  })

  it("bounds how many bindings of removed attachments it keeps", () => {
    const citations = createAttachmentCitations()
    const total = DETACHED_BINDING_LIMIT + 5
    for (let i = 0; i < total; i++) {
      citations.expect(planFile, { ...PLAN, id: `lark:doc_${i}` })
      citations.observe([attachment(`a${i}`, planFile)])
    }
    // Everything but the last attachment has been removed by now.
    citations.observe([attachment(`a${total - 1}`, planFile)])
    citations.expect(budgetFile, BUDGET)
    citations.observe([attachment(`a${total - 1}`, planFile), attachment("b", budgetFile)])
    expect(citations.citationOf("a0")).toBeUndefined()
    expect(citations.citationOf(`a${total - 2}`)).toBeDefined()
    // A live binding is never evicted, however old.
    expect(citations.citationOf(`a${total - 1}`)).toBeDefined()
    expect(citations.citationOf("b")).toEqual(BUDGET)
  })
})

describe("remoteDocCitation", () => {
  const doc: RemoteDocRef = {
    providerId: "lark",
    kind: "doc",
    id: "doc_1",
    title: "Release plan",
    url: "https://x.feishu.cn/docx/doc_1",
  }

  it("cites `<providerId>:<documentId>` under the fetched title", () => {
    expect(remoteDocCitation({ providerId: "lark", doc }, "Release plan v2")).toEqual({
      kind: "doc",
      id: "lark:doc_1",
      label: "Release plan v2",
      raw: "https://x.feishu.cn/docx/doc_1",
    })
  })

  it("falls back to the picker title and a token when there is no title or link", () => {
    const bare = { ...doc, url: undefined }
    expect(remoteDocCitation({ providerId: "lark", doc: bare }, "")).toEqual({
      kind: "doc",
      id: "lark:doc_1",
      label: "Release plan",
      raw: "@lark:doc_1",
    })
  })
})
