import type { HandoffEnvelope } from "@cognia/agent-config-types/handoff-envelope"

import {
  CrossHostPreflightError,
  preflightCrossHostDispatch,
  type CrossHostTarget,
} from "./cross-host-preflight"

function envelope(overrides: Partial<HandoffEnvelope["execution"]> = {}): HandoffEnvelope {
  return {
    envelopeVersion: 1,
    identity: {
      parentRunId: "run-parent",
      childRunId: "run-child",
      depth: 1,
      parentChain: ["run-parent"],
    },
    task: { prompt: "do the work" },
    execution: {
      mode: "orchestrated",
      runtimeAdapter: "claude-agent-sdk",
      credentialProfileRef: "cred-1",
      ...overrides,
    },
    resources: [{ kind: "workspace", ref: "ws:team:task" }],
    createdAt: "2026-07-23T00:00:00.000Z",
  }
}

function target(overrides: Partial<CrossHostTarget> = {}): CrossHostTarget {
  return {
    hostRef: "remote-host-1",
    capabilities: ["streaming", "tools.ordinary", "session.multi-turn"],
    localCredentialProfileRefs: ["cred-1"],
    ...overrides,
  }
}

function run(input: Partial<Parameters<typeof preflightCrossHostDispatch>[0]> = {}) {
  return preflightCrossHostDispatch({
    envelope: envelope(),
    target: target(),
    requiredCapabilities: ["streaming", "tools.ordinary"],
    leaseHeld: true,
    ...input,
  })
}

describe("preflightCrossHostDispatch", () => {
  it("passes all gates and pins the target host into envelope + child policy", () => {
    const result = run()
    expect(result.envelope.execution.hostRef).toBe("remote-host-1")
    expect(result.hostPin).toEqual({ mode: "pinned", hostRef: "remote-host-1" })
  })

  it("rejects an invalid envelope (local absolute path resource) before anything else", () => {
    const bad = envelope()
    bad.resources = [{ kind: "workspace", ref: "/Users/alice/repo" }]
    try {
      run({ envelope: bad })
      throw new Error("expected preflight to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CrossHostPreflightError)
      expect((err as CrossHostPreflightError).code).toBe("envelope-invalid")
    }
  })

  it("rejects an envelope that cannot survive JSON serialization", () => {
    const cyclic = envelope() as HandoffEnvelope & { self?: unknown }
    cyclic.self = cyclic
    try {
      run({ envelope: cyclic })
      throw new Error("expected preflight to throw")
    } catch (err) {
      expect((err as CrossHostPreflightError).code).toBe("envelope-not-serializable")
    }
  })

  it("stringifies non-Error serialization failures into the typed detail", () => {
    const poisoned = envelope() as HandoffEnvelope & { toJSON?: unknown }
    // JSON.stringify surfaces whatever toJSON throws — including non-Errors.
    Object.defineProperty(poisoned, "toJSON", {
      value: () => {
        throw "raw failure string"
      },
    })
    try {
      run({ envelope: poisoned })
      throw new Error("expected preflight to throw")
    } catch (err) {
      const e = err as CrossHostPreflightError
      expect(e.code).toBe("envelope-not-serializable")
      expect(e.detail).toEqual(["raw failure string"])
    }
  })

  it("fails closed when the target host misses a hard capability, naming it", () => {
    try {
      run({ requiredCapabilities: ["streaming", "mcp"] })
      throw new Error("expected preflight to throw")
    } catch (err) {
      const e = err as CrossHostPreflightError
      expect(e.code).toBe("capability-missing")
      expect(e.detail).toEqual(["mcp"])
    }
  })

  it("fails closed when the credential reference is not local to the target host", () => {
    try {
      run({ target: target({ localCredentialProfileRefs: ["other-cred"] }) })
      throw new Error("expected preflight to throw")
    } catch (err) {
      const e = err as CrossHostPreflightError
      expect(e.code).toBe("credential-not-local")
      expect(e.detail).toEqual(["cred-1"])
    }
  })

  it("requires the single-writer lease BEFORE dispatch", () => {
    try {
      run({ leaseHeld: false })
      throw new Error("expected preflight to throw")
    } catch (err) {
      expect((err as CrossHostPreflightError).code).toBe("lease-not-held")
    }
  })

  it("an envelope without a credential ref passes locality (nothing to localize)", () => {
    const anon = envelope({ credentialProfileRef: undefined })
    const result = run({
      envelope: anon,
      target: target({ localCredentialProfileRefs: [] }),
    })
    expect(result.envelope.execution.hostRef).toBe("remote-host-1")
  })
})
