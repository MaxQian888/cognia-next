import { turnMetadataSendOptions } from "./turn-metadata"

describe("turnMetadataSendOptions", () => {
  it("omits absent fields so a spread adds no undefined keys", () => {
    expect(turnMetadataSendOptions(undefined)).toEqual({})
    expect(turnMetadataSendOptions({})).toEqual({})
    expect(Object.keys(turnMetadataSendOptions({ webSearchContext: undefined }))).toEqual([])
  })

  it("forwards the web-search context and the reply reference as given", () => {
    const webSearchContext = { provider: "tavily", results: [] }
    const replyTo = { messageId: "m1", preview: "p" }
    expect(turnMetadataSendOptions({ webSearchContext, replyTo })).toEqual({
      webSearchContext,
      replyTo,
    })
  })
})

it("carries the picked room members only when there are any (ADR-0177 batch 3)", () => {
  expect(turnMetadataSendOptions({ targetMemberIds: ["a", "b"] })).toEqual({
    targetMemberIds: ["a", "b"],
  })
  expect(turnMetadataSendOptions({ targetMemberIds: [] })).toEqual({})
})

it("carries the preamble summary and the turn's citations when present", () => {
  const promptPreamble = { sections: ["references" as const], references: [] }
  const citations = [{ kind: "entity" as const, id: "issue:i1", label: "Bug" }]
  expect(turnMetadataSendOptions({ promptPreamble, citations })).toEqual({
    promptPreamble,
    citations,
  })
  expect(turnMetadataSendOptions({ citations: [] })).toEqual({})
})

it("carries the addressed route under the send path's name, and only when set", () => {
  const route = {
    target: { kind: "runtime" as const, runtime: "codex" as const },
    handle: "codex",
    label: "codex",
  }
  expect(turnMetadataSendOptions({ route })).toEqual({ turnRoute: route })
  expect("turnRoute" in turnMetadataSendOptions({})).toBe(false)
})
