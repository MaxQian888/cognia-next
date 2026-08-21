import {
  AGENT_CAPABILITY_IDS,
  type ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"
import { SESSION_API_CAPABILITIES, SESSION_CONTROL_CAPABILITIES } from "@cognia/agent-config-types"
import { PINNED_RUNTIME_VERSIONS } from "@cognia/agent-config-types/runtime-versions"

import {
  buildCapabilitySnapshot,
  capabilitySnapshotDigest,
  snapshotAllowsControl,
  snapshotAllowsSessionApi,
} from "./capability-snapshot"
import { RUNTIME_CAPABILITIES, resolveAgentExecutionSpec } from "./resolve-agent-execution-spec"
import type { AgentExecutionFlag } from "./feature-flags"

const flags: Record<AgentExecutionFlag, boolean> = {
  agentTeamRemoteDispatch: false,
  genericAgentHostCommands: false,
  gatewayAgentRouteTickets: false,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: false,
  claudeSdkParityV1: false,
  claudeSdkSessionStore: false,
  claudeSdkCheckpoint: false,
  claudeSdkPrewarm: false,
}

function spec(
  legacy: Parameters<typeof resolveAgentExecutionSpec>[0]["legacy"] = {},
  environment = { isTauri: true, isHeadlessHost: false }
): ResolvedAgentExecutionSpec {
  return resolveAgentExecutionSpec({
    surface: "team",
    environment,
    flags,
    legacy: { providerId: "anthropic", toolsEnabled: true, ...legacy },
    now: "2026-08-03T00:00:00.000Z",
  }).spec
}

describe("buildCapabilitySnapshot", () => {
  it("reports the WHOLE vocabulary, not just what the runtime granted", () => {
    // A surface that listed only what works cannot show a user what does not:
    // "absent" and "unsupported" would render identically.
    const snapshot = buildCapabilitySnapshot(spec())
    expect(snapshot.capabilities).toHaveLength(AGENT_CAPABILITY_IDS.length)
    expect(snapshot.counts.total).toBe(AGENT_CAPABILITY_IDS.length)
    expect(snapshot.counts.native + snapshot.counts.unsupported + snapshot.counts.equivalent).toBe(
      AGENT_CAPABILITY_IDS.length
    )
  })

  it("marks exactly the claude rail's table as native", () => {
    const snapshot = buildCapabilitySnapshot(spec())
    const native = snapshot.capabilities.filter((c) => c.support === "native").map((c) => c.id)
    expect(native.sort()).toEqual([...RUNTIME_CAPABILITIES["claude-agent-sdk"]].sort())
  })

  it("a different runtime yields a different verdict for the same capability", () => {
    // The snapshot has to be a function of the spec, not of the vocabulary.
    const claude = buildCapabilitySnapshot(spec())
    const generic = buildCapabilitySnapshot(spec({ providerId: "openai" }))
    expect(generic.runtimeAdapter).toBe("ai-sdk")
    expect(claude.counts.native).not.toBe(generic.counts.native)
  })

  it("rows carry the controls and session functions the capability unlocks", () => {
    const snapshot = buildCapabilitySnapshot(spec())
    const mcpDynamic = snapshot.capabilities.find((c) => c.id === "mcp.dynamic")
    expect(mcpDynamic?.controls).toEqual(["setMcpPermissionModeOverride", "setMcpServers"])

    const manage = snapshot.capabilities.find((c) => c.id === "session.manage")
    expect(manage?.sessionFunctions).toContain("deleteSession")
    expect(manage?.sessionFunctions).toContain("renameSession")

    // Derived from the capability maps, so a method added to the manifest
    // shows up without anyone remembering to update this file.
    const everyControl = snapshot.capabilities.flatMap((c) => c.controls)
    expect(everyControl.sort()).toEqual(Object.keys(SESSION_CONTROL_CAPABILITIES).sort())
    const everyFn = snapshot.capabilities.flatMap((c) => c.sessionFunctions)
    expect(everyFn.sort()).toEqual(Object.keys(SESSION_API_CAPABILITIES).sort())
  })

  it("carries the resolver's reason for a capability the caller actually asked about", () => {
    const snapshot = buildCapabilitySnapshot(
      resolveAgentExecutionSpec({
        surface: "team",
        environment: { isTauri: true, isHeadlessHost: false },
        flags,
        legacy: { providerId: "openai", toolsEnabled: true },
        policy: { prefers: ["checkpoint"] },
        now: "2026-08-03T00:00:00.000Z",
      }).spec
    )
    const checkpoint = snapshot.capabilities.find((c) => c.id === "checkpoint")
    expect(checkpoint?.support).toBe("unsupported")
    expect(checkpoint?.reason).toMatch(/does not implement/)

    // Nothing was asked about `sandbox.native`, so the spec recorded no
    // evidence and the snapshot invents none. The UI supplies its own generic
    // wording — copying the resolver's phrasing here would be a second place
    // to change it and a fabricated specificity in the export.
    const sandbox = snapshot.capabilities.find((c) => c.id === "sandbox.native")
    expect(sandbox?.support).toBe("unsupported")
    expect(sandbox?.reason).toBeUndefined()
  })

  it("falls back to `effective` on a v1 spec instead of reporting nothing works", () => {
    // A v1 spec has no `support` map. Answering "unsupported" for all 40 would
    // not be a coarse answer — it would be a wrong one.
    const v1 = { ...spec(), specVersion: 1 as const }
    v1.capabilities = { effective: v1.capabilities.effective, disabledOptional: [] }
    const snapshot = buildCapabilitySnapshot(v1)
    expect(snapshot.specVersion).toBe(1)
    expect(snapshot.counts.native).toBe(v1.capabilities.effective.length)
  })

  it("pins the SDK version so a stale snapshot is recognisable", () => {
    expect(buildCapabilitySnapshot(spec()).agentSdkVersion).toBe(
      PINNED_RUNTIME_VERSIONS.agentSdkVersion
    )
    expect(buildCapabilitySnapshot(spec(), { agentSdkVersion: "0.0.1" }).agentSdkVersion).toBe(
      "0.0.1"
    )
  })

  it("copies no credential material", () => {
    // ADR-0090 constraint 4. The spec holds references only, and the snapshot
    // is the artifact most likely to be exported or logged.
    const withCred = resolveAgentExecutionSpec({
      surface: "team",
      environment: { isTauri: true, isHeadlessHost: false },
      flags,
      legacy: { providerId: "anthropic", toolsEnabled: true },
      policy: { credentialProfileRef: "cred-secret-1" },
      now: "2026-08-03T00:00:00.000Z",
    }).spec
    const serialised = JSON.stringify(buildCapabilitySnapshot(withCred))
    expect(serialised).not.toContain("cred-secret-1")
    expect(serialised).not.toContain("credential")
  })
})

describe("snapshotAllowsControl / snapshotAllowsSessionApi", () => {
  it("gates on the capability the method needs, per runtime", () => {
    const claude = buildCapabilitySnapshot(spec())
    const generic = buildCapabilitySnapshot(spec({ providerId: "openai" }))

    expect(snapshotAllowsControl(claude, "setMcpServers")).toBe(true)
    expect(snapshotAllowsControl(generic, "setMcpServers")).toBe(false)
    expect(snapshotAllowsSessionApi(claude, "deleteSession")).toBe(true)
    expect(snapshotAllowsSessionApi(generic, "deleteSession")).toBe(false)
  })

  it("every control and session function the claude rail exposes is reachable on it", () => {
    // The rail claims these capabilities; if a method's capability is not in
    // the table the UI would render a permanently dead button.
    const claude = buildCapabilitySnapshot(spec())
    for (const method of Object.keys(SESSION_CONTROL_CAPABILITIES) as Array<
      keyof typeof SESSION_CONTROL_CAPABILITIES
    >) {
      expect([method, snapshotAllowsControl(claude, method)]).toEqual([method, true])
    }
    for (const method of Object.keys(SESSION_API_CAPABILITIES) as Array<
      keyof typeof SESSION_API_CAPABILITIES
    >) {
      expect([method, snapshotAllowsSessionApi(claude, method)]).toEqual([method, true])
    }
  })
})

describe("capabilitySnapshotDigest", () => {
  it("is equal for two identical specs and differs on any axis", () => {
    // This is what the cross-surface E2E compares, so it must be sensitive to
    // more than the capability list.
    expect(capabilitySnapshotDigest(buildCapabilitySnapshot(spec()))).toBe(
      capabilitySnapshotDigest(buildCapabilitySnapshot(spec()))
    )
    expect(capabilitySnapshotDigest(buildCapabilitySnapshot(spec()))).not.toBe(
      capabilitySnapshotDigest(buildCapabilitySnapshot(spec({ providerId: "openai" })))
    )
    expect(
      capabilitySnapshotDigest(buildCapabilitySnapshot(spec(), { agentSdkVersion: "0.0.1" }))
    ).not.toBe(capabilitySnapshotDigest(buildCapabilitySnapshot(spec())))
  })

  it("two specs with the same capabilities but different fingerprints differ", () => {
    const a = buildCapabilitySnapshot(spec())
    const b = buildCapabilitySnapshot({ ...spec(), executionFingerprint: "other" })
    expect(a.counts).toEqual(b.counts)
    expect(capabilitySnapshotDigest(a)).not.toBe(capabilitySnapshotDigest(b))
  })
})
