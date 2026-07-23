import {
  assertNoNewRawTeammateCredentials,
  migrateTeammateExecutionBinding,
  RawTeammateCredentialError,
  resolveTeammateExecutionBinding,
} from "./execution-binding-resolver"

describe("resolveTeammateExecutionBinding", () => {
  it("member wins over run/team/app when set", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "pinned", deploymentRef: "dep-member" },
      runOverride: { mode: "pinned", deploymentRef: "dep-run" },
      teamDefault: { mode: "pinned", deploymentRef: "dep-team" },
      appDefault: { mode: "pinned", deploymentRef: "dep-app" },
    })
    expect(resolved.source).toBe("member")
    expect(resolved.policy).toEqual({ deploymentRef: "dep-member" })
    expect(resolved.trace.managedForced).toBe(false)
  })

  it("inherit falls through the fixed precedence chain member → run → team → app", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "inherit" },
      runOverride: { mode: "inherit" },
      teamDefault: { mode: "pinned", runtimePolicy: "ai-sdk", modelRole: "fast" },
      appDefault: { mode: "pinned", deploymentRef: "dep-app" },
    })
    expect(resolved.source).toBe("team-default")
    expect(resolved.policy).toEqual({ runtimePolicy: "ai-sdk", modelBindingRef: "fast" })
    expect(resolved.trace.consulted).toEqual(["managed", "member", "run", "team-default"])
  })

  it("managed force-all short-circuits everything and is EXPLICIT in the trace", () => {
    const resolved = resolveTeammateExecutionBinding({
      managedForceAll: { mode: "pinned", deploymentRef: "dep-managed" },
      member: { mode: "pinned", deploymentRef: "dep-member" },
    })
    expect(resolved.source).toBe("managed")
    expect(resolved.policy).toEqual({ deploymentRef: "dep-managed" })
    expect(resolved.trace.managedForced).toBe(true)
  })

  it("pool mode exposes candidate ids ONLY — no policy leaks", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "pool", candidateIds: ["dep-a", "dep-b"] },
    })
    expect(resolved.source).toBe("member")
    expect(resolved.candidateIds).toEqual(["dep-a", "dep-b"])
    expect(resolved.policy).toEqual({})
  })

  it("a fully-inherited chain resolves to the app default with an empty policy", () => {
    const resolved = resolveTeammateExecutionBinding({})
    expect(resolved.source).toBe("app-default")
    expect(resolved.policy).toEqual({})
    expect(resolved.candidateIds).toBeUndefined()
  })

  it("pinned credential references pass through as refs", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "pinned", credentialProfileRef: "cred-1" },
    })
    expect(resolved.policy).toEqual({ credentialProfileRef: "cred-1" })
  })
})

describe("assertNoNewRawTeammateCredentials", () => {
  it("rejects a NEW raw apiKey or baseURL write with a typed error", () => {
    expect(() => assertNoNewRawTeammateCredentials({ apiKey: "sk-raw" })).toThrow(
      RawTeammateCredentialError
    )
    expect(() =>
      assertNoNewRawTeammateCredentials({ baseURL: "https://api.vendor.example" })
    ).toThrow(RawTeammateCredentialError)
  })

  it("keeps legacy rows readable: unchanged values carried over pass", () => {
    const previous = { apiKey: "sk-legacy", baseURL: "https://old.example" }
    expect(() => assertNoNewRawTeammateCredentials({ ...previous }, previous)).not.toThrow()
  })

  it("rejects CHANGING an existing raw value (that is a new write)", () => {
    expect(() =>
      assertNoNewRawTeammateCredentials({ apiKey: "sk-new" }, { apiKey: "sk-legacy" })
    ).toThrow(RawTeammateCredentialError)
  })

  it("accepts configs without raw credentials", () => {
    expect(() =>
      assertNoNewRawTeammateCredentials({ model: "m", execution: { mode: "inherit" } })
    ).not.toThrow()
  })
})

describe("migrateTeammateExecutionBinding", () => {
  it("keeps an existing execution binding untouched", () => {
    const execution = { mode: "pinned" as const, deploymentRef: "dep-1" }
    expect(migrateTeammateExecutionBinding({ execution })).toBe(execution)
  })

  it("maps a legacy raw-credential row onto its provider-id deployment ref (no raw copy)", () => {
    const migrated = migrateTeammateExecutionBinding({
      provider: "zhipu",
      apiKey: "sk-legacy",
      baseURL: "https://open.bigmodel.cn",
    })
    expect(migrated).toEqual({ mode: "pinned", deploymentRef: "zhipu" })
    expect(JSON.stringify(migrated)).not.toContain("sk-legacy")
    expect(JSON.stringify(migrated)).not.toContain("bigmodel")
  })

  it("returns undefined when there is nothing to migrate", () => {
    expect(migrateTeammateExecutionBinding({})).toBeUndefined()
    expect(migrateTeammateExecutionBinding({ apiKey: "sk-x" })).toBeUndefined()
  })
})
