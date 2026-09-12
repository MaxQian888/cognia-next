import {
  claudeSdkRolloutOptions,
  sdkSessionApiOptions,
  sdkOptionsForStorage,
  sdkSessionStorageFromOptions,
} from "./claude-sdk-rollout"

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

describe("SDK session storage binding", () => {
  it("builds a host and workspace scoped descriptor without inheriting tenant authority", async () => {
    const options = await sdkSessionApiOptions({
      cwd: "/work",
      storage: "host-sqlite",
      environment: { isTauri: false, isHeadlessHost: true },
      surface: "cli",
    })
    expect(options).toMatchObject({
      cwd: "/work",
      execution: { hostRef: "headless-agent-host" },
      claudeAgentSdk: {
        version: 1,
        persistSession: true,
        sessionStore: { backend: "host-sqlite" },
      },
    })
    expect((await sdkSessionApiOptions({ storage: "filesystem" })).claudeAgentSdk).toEqual({
      version: 1,
    })
  })
  it("retains backend and original workspace when flags or cwd change", () => {
    const storage = sdkSessionStorageFromOptions({
      cwd: "/original",
      claudeAgentSdk: { version: 1, sessionStore: { backend: "host-sqlite" } },
    })
    expect(storage).toEqual({ backend: "host-sqlite", workspace: "/original" })
    expect(sdkOptionsForStorage(storage, { version: 1, enableFileCheckpointing: true })).toEqual({
      version: 1,
      persistSession: true,
      sessionStore: { backend: "host-sqlite", workspace: "/original" },
    })
    expect(
      sdkSessionStorageFromOptions({
        cwd: "/new",
        claudeAgentSdk: sdkOptionsForStorage({ backend: "host-sqlite", workspace: null }),
      }).workspace
    ).toBeNull()
    expect(
      sdkOptionsForStorage(
        { backend: "filesystem" },
        { version: 1, sessionStore: { backend: "host-sqlite" } }
      ).sessionStore
    ).toBeUndefined()
  })
})
