import {
  __resetPlacementReportsForTests,
  forgetPlacementReport,
  onSandboxPlacementReport,
  readPlacementEvent,
  readWorkspacePublishEvent,
  readTaskDeliveryRecord,
  recordTaskDelivery,
  sandboxDeliveryRecords,
  recordPlacementReport,
  recordWorkspacePublish,
  sandboxPlacementReport,
  subscribeSandboxPlacements,
} from "./placement-report"
import {
  SANDBOX_PLACEMENT_CHANNEL,
  WORKSPACE_PUBLISH_CHANNEL,
} from "@/types/sandbox/environment-spec"

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

describe("remote placements (ADR-0221)", () => {
  it("reads the provider and the workspace a remote driver reports", () => {
    expect(
      readPlacementEvent(
        sandboxEvent({
          driver: "e2b",
          provider: "cloud",
          workspace: {
            remoteUrl: "https://github.com/acme/app.git",
            baseRef: "main",
            branch: "cognia/a1",
          },
        })
      )
    ).toMatchObject({
      driver: "e2b",
      provider: "cloud",
      workspace: {
        remoteUrl: "https://github.com/acme/app.git",
        baseRef: "main",
        branch: "cognia/a1",
      },
    })
    const local = readPlacementEvent(sandboxEvent())
    expect(local).not.toHaveProperty("provider")
    expect(local).not.toHaveProperty("workspace")
  })

  it("reads a publish as the Host emits it, and keeps it on the agent's report", () => {
    // `workspace_publish_payload` in exec_backend.rs.
    const event = readWorkspacePublishEvent({
      agentId: "a1",
      publish: { branch: "cognia/a1", pushed: true, commit: "f".repeat(40), extra: 1 },
    })
    expect(event).toEqual({
      agentId: "a1",
      publish: { branch: "cognia/a1", pushed: true, commit: "f".repeat(40) },
    })
    expect(readWorkspacePublishEvent({ publish: {} })).toBeNull()
    expect(readWorkspacePublishEvent({ agentId: "a1", publish: { pushed: "yes" } })).toEqual({
      agentId: "a1",
      publish: {},
    })

    recordPlacementReport({ agentId: "a1", kind: "sandbox", provider: "cloud" })
    recordWorkspacePublish("a1", { pushed: false, code: "nothing_to_publish" })
    expect(sandboxPlacementReport("a1")).toEqual({
      agentId: "a1",
      kind: "sandbox",
      provider: "cloud",
      publish: { pushed: false, code: "nothing_to_publish" },
    })
    recordWorkspacePublish("late", { pushed: true })
    expect(sandboxPlacementReport("late")?.publish).toEqual({ pushed: true })
  })

  it("keeps where undelivered work went, and drops recovery fields of the wrong type", () => {
    // `preserve_workspace` and the held/discarded flags in remote_prep.rs.
    expect(
      readWorkspacePublishEvent({
        agentId: "a1",
        publish: {
          pushed: false,
          code: "sandbox_workspace_push_refused",
          recovery: {
            bundle: "/data/sandbox-recovery/a1.bundle",
            commit: "b".repeat(40),
            commits: 2,
            bytes: 512,
            extra: true,
          },
        },
      })?.publish
    ).toEqual({
      pushed: false,
      code: "sandbox_workspace_push_refused",
      recovery: {
        bundle: "/data/sandbox-recovery/a1.bundle",
        commit: "b".repeat(40),
        commits: 2,
        bytes: 512,
      },
    })
    expect(
      readWorkspacePublishEvent({
        agentId: "a1",
        publish: {
          held: true,
          discarded: "yes",
          recovery: { code: "sandbox_workspace_recovery_failed", commits: -1, bytes: 1.5 },
        },
      })?.publish
    ).toEqual({ held: true, recovery: { code: "sandbox_workspace_recovery_failed" } })
    expect(
      readWorkspacePublishEvent({ agentId: "a1", publish: { discarded: true, recovery: "x" } })
        ?.publish
    ).toEqual({ discarded: true })
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
    const listen = jest.fn(async (channel: string, next: (payload: unknown) => void) => {
      if (channel === SANDBOX_PLACEMENT_CHANNEL) handler = next
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

  it("records publishes from the workspace-publish channel too", async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const stops = { placement: jest.fn(), publish: jest.fn() }
    const listen = jest.fn(async (channel: string, next: (payload: unknown) => void) => {
      handlers.set(channel, next)
      return channel === WORKSPACE_PUBLISH_CHANNEL ? stops.publish : stops.placement
    })
    const unsubscribe = await subscribeSandboxPlacements(listen)
    handlers.get(WORKSPACE_PUBLISH_CHANNEL)?.({ agentId: "a1", publish: { pushed: true } })
    expect(sandboxPlacementReport("a1")?.publish).toEqual({ pushed: true })
    unsubscribe()
    expect(stops.placement).toHaveBeenCalled()
    expect(stops.publish).toHaveBeenCalled()
  })

  it("releases the placement listener when the publish channel cannot be opened", async () => {
    const stop = jest.fn()
    const listen = jest.fn(async (channel: string) => {
      if (channel === WORKSPACE_PUBLISH_CHANNEL) throw new Error("no channel")
      return stop
    })
    await expect(subscribeSandboxPlacements(listen)).rejects.toThrow("no channel")
    expect(stop).toHaveBeenCalled()
  })
})

describe("durable delivery projection", () => {
  const delivery = (id: string, createdAt = 100, revision = 1) => ({
    id,
    agentId: "a1",
    providerId: "remote",
    instanceId: "box",
    branch: "task/one",
    publishState: "held" as const,
    cleanupState: "retained" as const,
    publish: { held: true },
    createdAt,
    updatedAt: createdAt,
    revision,
  })

  it("retains multiple sessions and ignores stale snapshots after live delivery", () => {
    recordTaskDelivery(delivery("first"))
    recordTaskDelivery(delivery("second", 200))
    recordTaskDelivery({
      ...delivery("first", 100, 2),
      publishState: "pushed",
      publish: { pushed: true },
      updatedAt: 300,
    })
    recordTaskDelivery(delivery("first"))
    expect(sandboxDeliveryRecords("a1").map((record) => record.id)).toEqual(["second", "first"])
    expect(sandboxDeliveryRecords("a1")[1].publishState).toBe("pushed")
    expect(sandboxPlacementReport("a1")?.delivery?.id).toBe("second")
  })

  it("keeps identical agent and session ids on different Hosts separate", () => {
    const host = {}
    recordTaskDelivery(delivery("same"))
    recordTaskDelivery({ ...delivery("same"), providerId: "other" }, host)
    expect(sandboxPlacementReport("a1")?.provider).toBe("remote")
    expect(sandboxPlacementReport("a1", host)?.provider).toBe("other")
  })

  it("parses embedded records without trusting malformed or misattributed records", () => {
    expect(readTaskDeliveryRecord({ ...delivery("one"), revision: -1 })).toBeUndefined()
    expect(readTaskDeliveryRecord({ ...delivery("one"), cleanupState: "unknown" })).toBeUndefined()
    expect(
      readWorkspacePublishEvent({
        agentId: "a1",
        publish: { held: true, deliveryRecord: delivery("one") },
      })?.delivery?.id
    ).toBe("one")
    expect(
      readWorkspacePublishEvent({
        agentId: "another",
        publish: { deliveryRecord: delivery("one") },
      })?.delivery
    ).toBeUndefined()
  })
})

it("keeps a successful delivery when only persisting cleanup failed, and accepts a real newer publish", () => {
  const error = { code: "sandbox_delivery_store_failed", message: "disk full" }
  recordWorkspacePublish("a1", { pushed: true, commit: "commit" })
  recordWorkspacePublish(
    "a1",
    { pushed: false, code: "sandbox_delivery_store_failed" },
    undefined,
    error
  )
  expect(sandboxPlacementReport("a1")?.publish).toEqual({ pushed: true, commit: "commit" })
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toEqual(error)
  recordWorkspacePublish("a1", { pushed: false, held: true, branch: "next" }, undefined, error)
  expect(sandboxPlacementReport("a1")?.publish?.held).toBe(true)
})

it("keeps a newer fallback badge separate from older remote delivery history", () => {
  recordPlacementReport({ agentId: "a1", kind: "fallback", code: "sandbox_fallback_pool_disabled" })
  recordTaskDelivery({
    id: "old",
    agentId: "a1",
    providerId: "remote",
    instanceId: "box",
    branch: "task/one",
    publishState: "pushed",
    cleanupState: "destroyed",
    publish: { pushed: true },
    createdAt: 1,
    updatedAt: 2,
    revision: 1,
  })
  expect(sandboxPlacementReport("a1")?.kind).toBe("fallback")
  expect(sandboxDeliveryRecords("a1")).toHaveLength(1)
})

it("reads the exact delivery identity from remote placement events", () => {
  expect(
    readPlacementEvent({
      agentId: "a1",
      placement: { kind: "sandbox", deliveryRecordId: "session-new" },
    })?.deliveryRecordId
  ).toBe("session-new")
})

it("ignores another session's persistence failure while keeping the current session publish", () => {
  recordPlacementReport({
    agentId: "a1",
    kind: "sandbox",
    provider: "new",
    deliveryRecordId: "new-session",
  })
  const error = { code: "sandbox_delivery_store_failed" }
  recordWorkspacePublish(
    "a1",
    { pushed: false, code: "sandbox_delivery_store_failed" },
    undefined,
    error,
    "old-session"
  )
  expect(sandboxPlacementReport("a1")?.publish).toBeUndefined()
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toBeUndefined()
  recordWorkspacePublish(
    "a1",
    { pushed: true, commit: "new-commit" },
    undefined,
    error,
    "new-session"
  )
  expect(sandboxPlacementReport("a1")?.publish?.pushed).toBe(true)
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toEqual(error)
})

it("retains the first failed-to-persist outcome even without a live placement", () => {
  recordWorkspacePublish(
    "a1",
    { pushed: true },
    undefined,
    { code: "sandbox_delivery_store_failed" },
    "first-session"
  )
  expect(sandboxPlacementReport("a1")?.publish?.pushed).toBe(true)
  expect(sandboxPlacementReport("a1")?.deliveryRecordId).toBe("first-session")
})

it("preserves a failed-to-persist success against a delayed running record until persistence catches up", () => {
  recordPlacementReport({ agentId: "a1", kind: "sandbox", deliveryRecordId: "session" })
  const error = { code: "sandbox_delivery_store_failed" }
  const published = { pushed: true, branch: "task/one", commit: "published-commit" }
  recordWorkspacePublish("a1", published, undefined, error, "session")
  const running = {
    id: "session",
    agentId: "a1",
    providerId: "remote",
    instanceId: "box",
    branch: "task/one",
    publishState: "running" as const,
    cleanupState: "retained" as const,
    publish: { pushed: false, code: "session_running" },
    createdAt: 100,
    updatedAt: 100,
    revision: 1,
  }
  recordTaskDelivery(running)
  expect(sandboxPlacementReport("a1")?.publish).toEqual(published)
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toEqual(error)
  expect(sandboxDeliveryRecords("a1")[0].publishState).toBe("running")
  recordTaskDelivery({ ...running, revision: 2, publishState: "pushed", publish: published })
  expect(sandboxPlacementReport("a1")?.publish).toEqual(published)
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toBeUndefined()
})

it("keeps a failed-to-persist saved bundle over equal and newer stale held records", () => {
  const held = {
    id: "session",
    agentId: "a1",
    providerId: "remote",
    instanceId: "box",
    branch: "task/one",
    publishState: "held" as const,
    cleanupState: "retained" as const,
    publish: { pushed: false, held: true },
    createdAt: 100,
    updatedAt: 100,
    revision: 1,
  }
  recordPlacementReport({ agentId: "a1", kind: "sandbox", deliveryRecordId: "session" })
  recordTaskDelivery(held)
  const error = { code: "sandbox_delivery_store_failed" }
  const saved = { pushed: false, recovery: { bundle: "/host/work.bundle", commit: "saved-commit" } }
  recordWorkspacePublish("a1", saved, undefined, error, "session")
  recordTaskDelivery(held)
  recordTaskDelivery({ ...held, revision: 2, cleanupState: "pending" })
  expect(sandboxPlacementReport("a1")?.publish).toEqual(saved)
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toEqual(error)
  recordTaskDelivery({ ...held, revision: 3, publishState: "savedBundle", publish: saved })
  expect(sandboxPlacementReport("a1")?.publish).toEqual(saved)
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toBeUndefined()
})

it("accepts durable delivery progress beyond a failed-to-persist held outcome", () => {
  recordPlacementReport({ agentId: "a1", kind: "sandbox", deliveryRecordId: "session" })
  recordWorkspacePublish(
    "a1",
    { pushed: false, held: true },
    undefined,
    { code: "sandbox_delivery_store_failed" },
    "session"
  )
  recordTaskDelivery({
    id: "session",
    agentId: "a1",
    providerId: "remote",
    instanceId: "box",
    branch: "task/one",
    publishState: "savedBundle",
    cleanupState: "destroyed",
    publish: { recovery: { bundle: "/host/work.bundle" } },
    createdAt: 100,
    updatedAt: 200,
    revision: 2,
  })
  expect(sandboxPlacementReport("a1")?.publish?.recovery?.bundle).toBe("/host/work.bundle")
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toBeUndefined()
})

it("clears a persistence failure when a sanitized retry preserves the known saved bundle", () => {
  recordPlacementReport({ agentId: "a1", kind: "sandbox", deliveryRecordId: "session" })
  const persisted = {
    pushed: false,
    code: "sandbox_workspace_push_refused",
    recovery: { bundle: "/host/work.bundle", commit: "saved-commit" },
  }
  recordWorkspacePublish(
    "a1",
    {
      ...persisted,
      message: "git diagnostic omitted from durable history",
      recovery: {
        ...persisted.recovery,
        message: "export diagnostic omitted from durable history",
      },
    },
    undefined,
    { code: "sandbox_delivery_store_failed" },
    "session"
  )
  recordTaskDelivery({
    id: "session",
    agentId: "a1",
    providerId: "remote",
    instanceId: "box",
    branch: "task/one",
    publishState: "savedBundle",
    cleanupState: "destroyed",
    publish: persisted,
    createdAt: 100,
    updatedAt: 200,
    revision: 2,
  })
  expect(sandboxPlacementReport("a1")?.publish).toEqual(persisted)
  expect(sandboxPlacementReport("a1")?.deliveryRecordError).toBeUndefined()
})
