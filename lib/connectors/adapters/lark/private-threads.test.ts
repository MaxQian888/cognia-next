import { LARK_PRIVATE_THREAD_REPLY, privateThreadReplyAnchor } from "./private-threads"

describe("privateThreadReplyAnchor", () => {
  it("uses the latest reply anchor rather than the stable session root", () => {
    expect(
      privateThreadReplyAnchor({
        [LARK_PRIVATE_THREAD_REPLY]: true,
        threadTs: "om_root",
        threadRootMessageId: "om_followup",
      })
    ).toBe("om_followup")
  })

  it("answers the anchor only for a reference that replies in threads", () => {
    expect(
      privateThreadReplyAnchor({ [LARK_PRIVATE_THREAD_REPLY]: true, threadRootMessageId: "om_1" })
    ).toBe("om_1")
    expect(privateThreadReplyAnchor({ threadRootMessageId: "om_1" })).toBeUndefined()
    expect(
      privateThreadReplyAnchor({ [LARK_PRIVATE_THREAD_REPLY]: true, threadRootMessageId: "" })
    ).toBeUndefined()
    expect(privateThreadReplyAnchor({ [LARK_PRIVATE_THREAD_REPLY]: true })).toBeUndefined()
    expect(privateThreadReplyAnchor(undefined)).toBeUndefined()
  })
})
