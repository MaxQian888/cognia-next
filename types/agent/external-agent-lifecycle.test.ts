import {
  EXTERNAL_AGENT_CREDENTIAL_SLOTS,
  EXTERNAL_AGENT_JS_PROVIDERS,
  EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES,
  EXTERNAL_AGENT_RUNTIME_PROVIDERS,
  ExternalAgentLifecycleError,
  JS_PROVIDER_FROZEN_INSTALL,
  assessUnsandboxedConsent,
  isBinaryDistribution,
  isExternalAgentLifecycleError,
  isExternalAgentLifecycleErrorCode,
  isJsDistribution,
  isJsRuntimeProvider,
  type ExternalAgentBinaryDistribution,
  type ExternalAgentJsDistribution,
  type UnsandboxedLaunchConsent,
  type UnsandboxedLaunchIdentity,
} from "./external-agent-lifecycle"

describe("lifecycle error codes", () => {
  it("exposes every code the plan pins as stable", () => {
    expect([...EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES]).toEqual([
      "runtime_missing",
      "version_unsupported",
      "version_uncertified",
      "integrity_failed",
      "credential_missing",
      "adapter_unavailable",
      "active_sessions",
      "runtime_referenced",
      "consent_required",
      "platform_unsupported",
    ])
  })

  it("recognizes only known codes", () => {
    expect(isExternalAgentLifecycleErrorCode("integrity_failed")).toBe(true)
    expect(isExternalAgentLifecycleErrorCode("kinda_broken")).toBe(false)
    expect(isExternalAgentLifecycleErrorCode(7)).toBe(false)
  })

  it("carries code and non-secret details on the error", () => {
    const error = new ExternalAgentLifecycleError("credential_missing", "no api key", {
      slot: "apiKey",
    })
    expect(error).toBeInstanceOf(Error)
    expect(isExternalAgentLifecycleError(error)).toBe(true)
    expect(error.code).toBe("credential_missing")
    expect(error.details).toEqual({ slot: "apiKey" })
    expect(error.message).toBe("no api key")
  })

  it("does not claim plain errors", () => {
    expect(isExternalAgentLifecycleError(new Error("nope"))).toBe(false)
  })
})

describe("providers", () => {
  it("treats exactly the JavaScript package managers as JS providers", () => {
    for (const provider of EXTERNAL_AGENT_RUNTIME_PROVIDERS) {
      expect(isJsRuntimeProvider(provider)).toBe(
        (EXTERNAL_AGENT_JS_PROVIDERS as readonly string[]).includes(provider)
      )
    }
  })

  it("pins a frozen-install command for every JS provider", () => {
    for (const provider of EXTERNAL_AGENT_JS_PROVIDERS) {
      const plan = JS_PROVIDER_FROZEN_INSTALL[provider]
      expect(plan.command).toBe(provider)
      expect(plan.args.length).toBeGreaterThan(0)
      expect(plan.lockfile).toBeTruthy()
    }
  })

  it("never offers a resolving install for a JS provider", () => {
    // `npm install` / `pnpm install` without a frozen flag would re-resolve the
    // range at install time, which is the exact failure the lock asset exists
    // to prevent.
    expect(JS_PROVIDER_FROZEN_INSTALL.npm.args).toEqual(["ci"])
    expect(JS_PROVIDER_FROZEN_INSTALL.pnpm.args).toContain("--frozen-lockfile")
    expect(JS_PROVIDER_FROZEN_INSTALL.bun.args).toContain("--frozen-lockfile")
  })
})

describe("distribution guards", () => {
  const js: ExternalAgentJsDistribution = {
    provider: "pnpm",
    packageName: "@example/agent",
    version: "1.2.3",
    entrypoint: "node_modules/.bin/example-agent",
    lockAsset: { path: "runtime/example/pnpm-lock.yaml", sha256: "a".repeat(64) },
  }
  const binary: ExternalAgentBinaryDistribution = {
    provider: "binary",
    version: "4.5.6",
    artifacts: [
      {
        platformKey: "darwin-arm64",
        url: "https://example.test/agent.tar.gz",
        integrity: { sha256: "b".repeat(64) },
        archive: "tar.gz",
        entrypoint: "bin/agent",
      },
    ],
  }

  it("separates JS from binary distributions", () => {
    expect(isJsDistribution(js)).toBe(true)
    expect(isJsDistribution(binary)).toBe(false)
    expect(isBinaryDistribution(binary)).toBe(true)
    expect(isBinaryDistribution(js)).toBe(false)
  })
})

describe("credential slots", () => {
  it("covers every secret-bearing field the plan enumerates", () => {
    expect([...EXTERNAL_AGENT_CREDENTIAL_SLOTS]).toEqual([
      "apiKey",
      "bearerToken",
      "headers",
      "proxyAuth",
      "processEnv",
    ])
  })
})

describe("assessUnsandboxedConsent", () => {
  const identity: UnsandboxedLaunchIdentity = {
    agentId: "agent-1",
    runtimeId: "codex-acp",
    executablePath: "C:\\tools\\codex.exe",
    executableDigest: "c".repeat(64),
    runtimeVersion: "1.0.0",
    commandDigest: "d".repeat(64),
    policyRevision: 1,
    hostId: "host-1",
    provider: "npm",
  }
  const consent: UnsandboxedLaunchConsent = {
    ...identity,
    confirmedAt: "2026-08-22T00:00:00.000Z",
  }

  it("accepts consent that still matches what would launch", () => {
    expect(assessUnsandboxedConsent(consent, identity)).toEqual({ valid: true, reasons: [] })
  })

  it("refuses when no consent was ever recorded", () => {
    expect(assessUnsandboxedConsent(null, identity)).toEqual({ valid: false, reasons: [] })
    expect(assessUnsandboxedConsent(undefined, identity)).toEqual({ valid: false, reasons: [] })
  })

  it.each([
    ["agent-mismatch", { agentId: "agent-2" }],
    ["runtime-mismatch", { runtimeId: "other" }],
    ["executable-path-changed", { executablePath: "C:\\other\\codex.exe" }],
    ["executable-changed", { executableDigest: "e".repeat(64) }],
    ["version-changed", { runtimeVersion: "1.0.1" }],
    ["command-changed", { commandDigest: "f".repeat(64) }],
    ["policy-revised", { policyRevision: 2 }],
    ["host-changed", { hostId: "host-2" }],
    ["provider-changed", { provider: "pnpm" as const }],
  ])("invalidates consent on %s", (reason, patch) => {
    const result = assessUnsandboxedConsent(consent, { ...identity, ...patch })
    expect(result.valid).toBe(false)
    expect(result.reasons).toEqual([reason])
  })

  it("treats a dropped provider as a provider change", () => {
    const result = assessUnsandboxedConsent(consent, { ...identity, provider: undefined })
    expect(result.valid).toBe(false)
    expect(result.reasons).toEqual(["provider-changed"])
  })

  it("reports every reason at once so the disclosure can explain the change", () => {
    const result = assessUnsandboxedConsent(consent, {
      ...identity,
      runtimeVersion: "2.0.0",
      executableDigest: "0".repeat(64),
      policyRevision: 9,
    })
    expect(result.valid).toBe(false)
    expect(result.reasons).toEqual(["executable-changed", "version-changed", "policy-revised"])
  })
})
