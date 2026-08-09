import { claudeSdkRolloutOptions } from "./claude-sdk-rollout"

describe("claudeSdkRolloutOptions", () => {
  it("returns no nested block while the master rollout is disabled", () => {
    expect(claudeSdkRolloutOptions({ claudeSdkParityV1: false })).toBeUndefined()
  })

  it("enables the versioned block and independently gates stateful features", () => {
    expect(
      claudeSdkRolloutOptions({
        claudeSdkParityV1: true,
        claudeSdkSessionStore: true,
        claudeSdkCheckpoint: false,
        claudeSdkPrewarm: true,
      })
    ).toEqual({
      version: 1,
      persistSession: true,
      sessionStore: { backend: "host-sqlite" },
      prewarm: { enabled: true },
    })
  })

  it("fails closed when mutually exclusive session storage and checkpoint flags are both set", () => {
    expect(() =>
      claudeSdkRolloutOptions({
        claudeSdkParityV1: true,
        claudeSdkSessionStore: true,
        claudeSdkCheckpoint: true,
      })
    ).toThrow(/mutually exclusive/)
  })
})
