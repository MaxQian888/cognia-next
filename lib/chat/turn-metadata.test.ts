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
