import {
  claudeSdkRolloutOptions,
  sdkSessionApiOptions,
  sdkOptionsForStorage,
  sdkSessionStorageFromOptions,
  claudeCodeRuntimeOptions,
} from "./claude-sdk-rollout"

describe("Claude Code runtime preferences", () => {
  it("keeps both capabilities off when no preference is saved", () => {
    expect(claudeCodeRuntimeOptions(undefined, { unattended: true })).toBeUndefined()
    expect(claudeCodeRuntimeOptions({}, { unattended: true })).toEqual({
      version: 1,
      sandbox: { allowNestedUserNamespaces: false },
    })
  })

  it("requests namespaces with a fail-closed sandbox and preserves unrelated SDK fields", () => {
    expect(
      claudeCodeRuntimeOptions(
        { allowNestedUserNamespaces: true },
        {
          unattended: false,
          current: {
            version: 1,
            persistSession: true,
            sandbox: { network: { allowedDomains: ["example.test"] } },
          },
        }
      )
    ).toEqual({
      version: 1,
      persistSession: true,
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        allowNestedUserNamespaces: true,
        network: { allowedDomains: ["example.test"] },
      },
    })
  })

  it("only enables watchdog retries for unattended turns, with finite defaults", () => {
    const preferences = { unattendedRetry: { enabled: true } }
    expect(
      claudeCodeRuntimeOptions(preferences, { unattended: false })?.unattendedRetry
    ).toBeUndefined()
    expect(claudeCodeRuntimeOptions(preferences, { unattended: true })?.unattendedRetry).toEqual({
      maxWaitMs: 1_800_000,
      usageLimitRecheckMs: 60_000,
    })
    expect(
      claudeCodeRuntimeOptions(
        { unattendedRetry: { enabled: true, maxWaitMs: 120_000, usageLimitRecheckMs: 90_000 } },
        { unattended: true }
      )?.unattendedRetry
    ).toEqual({ maxWaitMs: 120_000, usageLimitRecheckMs: 90_000 })
  })

  it("does not retain stale retry requests after disabling the preference", () => {
    expect(
      claudeCodeRuntimeOptions(
        { unattendedRetry: { enabled: false } },
        { unattended: true, current: { version: 1, unattendedRetry: { maxWaitMs: 60_000 } } }
      )?.unattendedRetry
    ).toBeUndefined()
  })

  it("rejects invalid saved bounds before sending to the sidecar", () => {
    expect(() =>
      claudeCodeRuntimeOptions(
        { unattendedRetry: { enabled: true, maxWaitMs: 0 } },
        { unattended: true }
      )
    ).toThrow(/maxWaitMs/)
  })
})

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
