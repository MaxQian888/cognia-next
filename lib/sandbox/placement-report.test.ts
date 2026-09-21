import {
  __resetPlacementReportsForTests,
  forgetPlacementReport,
  onSandboxPlacementReport,
  readPlacementEvent,
  recordPlacementReport,
  sandboxPlacementReport,
  subscribeSandboxPlacements,
} from "./placement-report"
import { SANDBOX_PLACEMENT_CHANNEL } from "@/types/sandbox/environment-spec"

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`
const BUNDLE_DIGEST = `sha256:${"b".repeat(64)}`

/**
 * Exactly what `placement_payload(agent_id, sandbox_placement(..))` emits
 * (`crates/cognia-external-agent/src/exec_backend.rs`,
 * `crates/cognia-sandbox-pool/src/docker.rs`). A reader written against an
 * imagined shape passes its own tests and reads nothing from a real Host.
 */
function sandboxEvent(over: Record<string, unknown> = {}) {
  return {
    agentId: "a1",
    placement: {
      kind: "sandbox",
      driver: "docker",
      specDigest: "c".repeat(64),
      image: `ghcr.io/acme/dev@${IMAGE_DIGEST}`,
      sizeClassId: "small",
      isolationTier: "gvisor",
      bundle: { digest: BUNDLE_DIGEST, releaseTag: "v1.2.3", libc: "musl" },
      command: "codex-acp",
      user: { name: "node", uid: 1000, gid: 1000, remappedFrom: { uid: 1001, gid: 1001 } },
      egress: { tier: "allowlist", enforced: false },
      credentials: { mode: "none" },
      ...over,
    },
  }
}

beforeEach(() => {
  __resetPlacementReportsForTests()
})

describe("readPlacementEvent", () => {
  it("reads the tier, user and digests the sandbox actually got", () => {
    expect(readPlacementEvent(sandboxEvent())).toEqual({
      agentId: "a1",
      kind: "sandbox",
      driver: "docker",
      specDigest: "c".repeat(64),
      image: `ghcr.io/acme/dev@${IMAGE_DIGEST}`,
      imageDigest: IMAGE_DIGEST,
      sizeClassId: "small",
      tier: "gvisor",
      bundleDigest: BUNDLE_DIGEST,
      bundleReleaseTag: "v1.2.3",
      libc: "musl",
      user: "node",
      uid: 1000,
      userRemapped: true,
      egressTier: "allowlist",
      egressEnforced: false,
      credentialsMode: "none",
    })
  })

  // `fallback_placement(code, message)` in `sandbox_routing_backend.rs`.
  it("keeps the fallback reason so a UI can say why nothing was sandboxed", () => {
    expect(
      readPlacementEvent({
        agentId: "a1",
        placement: {
          kind: "fallback",
          code: "sandbox_fallback_daemon_unreachable",
          message: "the container daemon did not answer",
        },
      })
    ).toEqual({
      agentId: "a1",
      kind: "fallback",
      code: "sandbox_fallback_daemon_unreachable",
      message: "the container daemon did not answer",
    })
  })

  // A client that guessed "sandbox" for a kind it did not recognize would
  // claim a sandbox ran. The honest answer to a newer Host is "unknown".
  it("reports an unrecognized kind as unknown rather than assuming a sandbox", () => {
    expect(readPlacementEvent({ agentId: "a1", placement: { kind: "pod" } })).toEqual({
      agentId: "a1",
      kind: "unknown",
    })
    expect(readPlacementEvent({ agentId: "a1" })?.kind).toBe("unknown")
  })

  it("rejects an event with no agent to attribute it to", () => {
    expect(readPlacementEvent(null)).toBeNull()
    expect(readPlacementEvent("sandbox")).toBeNull()
    expect(readPlacementEvent({ placement: { kind: "sandbox" } })).toBeNull()
    expect(readPlacementEvent({ agentId: "" })).toBeNull()
  })

  // `enforced: false` is a claim, and a missing field is a Host that did not
  // say. Collapsing them would let a UI print "not enforced" about a Host that
  // never answered the question.
  it("keeps a missing egress verdict distinct from an explicit false", () => {
    expect(readPlacementEvent(sandboxEvent({ egress: undefined }))?.egressEnforced).toBeUndefined()
    expect(readPlacementEvent(sandboxEvent())?.egressEnforced).toBe(false)
    expect(
      readPlacementEvent(sandboxEvent({ egress: { tier: "off", enforced: true } }))?.egressEnforced
    ).toBe(true)
  })

  // The driver writes `remappedFrom: null` when it did not remap, and omits
  // `user` entirely when the probe could not name one.
  it("tells a user that was not remapped from one the Host said nothing about", () => {
    expect(
      readPlacementEvent(
        sandboxEvent({ user: { name: "root", uid: 0, gid: 0, remappedFrom: null } })
      )?.userRemapped
    ).toBe(false)
    const unnamed = readPlacementEvent(sandboxEvent({ user: null }))
    expect(unnamed?.user).toBeUndefined()
    expect(unnamed?.userRemapped).toBeUndefined()
  })

  it("ignores a field of the wrong type instead of publishing it", () => {
    const report = readPlacementEvent(
      sandboxEvent({
        isolationTier: "kata",
        user: { name: 7, uid: "1000" },
        credentials: { mode: "" },
        egress: { tier: "sometimes", enforced: "no" },
      })
    )

    expect(report?.tier).toBeUndefined()
    expect(report?.user).toBeUndefined()
    expect(report?.uid).toBeUndefined()
    expect(report?.credentialsMode).toBeUndefined()
    expect(report?.egressTier).toBeUndefined()
    expect(report?.egressEnforced).toBeUndefined()
  })

  it("has no digest to report for an image reference without one", () => {
    expect(
      readPlacementEvent(sandboxEvent({ image: "ghcr.io/acme/dev:v1" }))?.imageDigest
    ).toBeUndefined()
  })
})

describe("the per-agent record", () => {
  it("keeps the newest report for an agent", () => {
    recordPlacementReport({ agentId: "a1", kind: "fallback", code: "x" })
    recordPlacementReport({ agentId: "a1", kind: "sandbox", tier: "container" })
    expect(sandboxPlacementReport("a1")).toEqual({
      agentId: "a1",
      kind: "sandbox",
      tier: "container",
    })
  })

  it("forgets an agent that is gone", () => {
    recordPlacementReport({ agentId: "a1", kind: "sandbox" })
    forgetPlacementReport("a1")
    expect(sandboxPlacementReport("a1")).toBeUndefined()
  })

  it("notifies subscribers and stops after unsubscribe", () => {
    const seen: string[] = []
    const stop = onSandboxPlacementReport((report) => seen.push(report.agentId))
    recordPlacementReport({ agentId: "a1", kind: "sandbox" })
    stop()
    recordPlacementReport({ agentId: "a2", kind: "sandbox" })
    expect(seen).toEqual(["a1"])
  })
})

describe("subscribeSandboxPlacements", () => {
  it("records what arrives on the placement channel and ignores what cannot be read", async () => {
    let handler: ((payload: unknown) => void) | undefined
    const stop = jest.fn()
    const listen = jest.fn(async (_channel: string, next: (payload: unknown) => void) => {
      handler = next
      return stop
    })

    const unsubscribe = await subscribeSandboxPlacements(listen)
    expect(listen).toHaveBeenCalledWith(SANDBOX_PLACEMENT_CHANNEL, expect.any(Function))

    handler?.(sandboxEvent({ isolationTier: "container" }))
    handler?.({ nonsense: true })
    expect(sandboxPlacementReport("a1")?.tier).toBe("container")

    unsubscribe()
    expect(stop).toHaveBeenCalled()
  })
})
