import { makeAdapterInstance, makeConversationLabel } from "./inbox"

describe("makeAdapterInstance", () => {
  it("uses the local-only media policy by default and honors an explicit override", () => {
    expect(makeAdapterInstance().mediaModelPolicy).toBe("local_extract_only")
    expect(makeAdapterInstance({ mediaModelPolicy: "allow_cloud_binary" }).mediaModelPolicy).toBe(
      "allow_cloud_binary"
    )
  })
})

describe("makeConversationLabel", () => {
  it("creates conversation-scoped labels and still honors explicit overrides", () => {
    expect(makeConversationLabel()).toMatchObject({ scope: "conversation", name: "follow-up" })
    expect(makeConversationLabel({ scope: "issue", name: "bug" })).toMatchObject({
      scope: "issue",
      name: "bug",
    })
  })
})
