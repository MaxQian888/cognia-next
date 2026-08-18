/**
 * @jest-environment jsdom
 */
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { INBOX_RELAY_HOST_OPERATIONS } from "@/lib/platform/host-feature-manifest"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"

import {
  INBOX_RELAY_FEATURE,
  INBOX_WRITE_COMMANDS,
  __setInboxWriteRouteDepsForTests,
  canEnqueueInboxWrite,
  hostSupportsInboxRelay,
  remoteHostOperations,
  resolveInboxWriteAvailability,
  resolveInboxWriteRoute,
} from "./route"

const EMPTY_SNAPSHOT: RuntimeSnapshot = {
  target: null,
  vaultState: "unlocked",
  connectionState: "online",
}

function snapshot(over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return { ...EMPTY_SNAPSHOT, ...over }
}

/**
 * A companion target whose host advertises the relay operations AND has
 * granted this device the capability they require. Both halves matter:
 * `resolveOperationAvailability` refuses on a missing grant before it ever
 * looks at connectivity.
 */
const RELAY_CAPABILITY = "workspace.write"

function companionSnapshot(
  operations: readonly string[] = INBOX_RELAY_HOST_OPERATIONS,
  over: Partial<RuntimeSnapshot> = {}
): RuntimeSnapshot {
  return snapshot({
    target: { kind: "companion", id: "host-1" } as RuntimeSnapshot["target"],
    host: { compatible: true, operations, grants: [RELAY_CAPABILITY] },
    ...over,
  })
}

function manifest(operations: readonly string[] = INBOX_RELAY_HOST_OPERATIONS): HostFeatureManifest {
  return {
    schemaVersion: 1,
    hostBuildId: "test-host",
    platform: "tauri",
    features: {
      [INBOX_RELAY_FEATURE]: { version: 1, operations: [...operations] },
    },
  } as unknown as HostFeatureManifest
}

/** Install a full route-dep set; returns the restore function. */
function withDeps(over: {
  remoteActive?: boolean
  connectorRuntime?: boolean
  snapshot?: RuntimeSnapshot
  manifest?: HostFeatureManifest | null
}): () => void {
  return __setInboxWriteRouteDepsForTests({
    isRemoteHostActive: () => over.remoteActive ?? false,
    hasConnectorRuntime: () => over.connectorRuntime ?? false,
    getRuntimeSnapshot: () => over.snapshot ?? EMPTY_SNAPSHOT,
    activeHostFeatureManifest: () => over.manifest ?? null,
  })
}

describe("resolveInboxWriteRoute — the shell matrix", () => {
  let restore: () => void = () => undefined
  afterEach(() => restore())

  it("routes a tauri/headless connector host to `local`", () => {
    restore = withDeps({ connectorRuntime: true })
    expect(resolveInboxWriteRoute()).toBe("local")
  })

  it("routes a paired phone / web companion to `remote`", () => {
    restore = withDeps({ snapshot: companionSnapshot() })
    expect(resolveInboxWriteRoute()).toBe("remote")
  })

  it("routes a standalone browser or unpaired phone to `unavailable`", () => {
    restore = withDeps({})
    expect(resolveInboxWriteRoute()).toBe("unavailable")
  })

  it("prefers `remote` over `local` while a desktop drives a remote host", () => {
    // The desktop still reports the `connector-runtime` capability from its
    // baseline, but its local runtime is torn down while the remote is
    // active. Falling into "local" here would enqueue an outbound job that
    // no running adapter would ever deliver.
    restore = withDeps({ remoteActive: true, connectorRuntime: true, manifest: manifest() })
    expect(resolveInboxWriteRoute()).toBe("remote")
  })
})

describe("resolveInboxWriteAvailability", () => {
  let restore: () => void = () => undefined
  afterEach(() => restore())

  it("is available with reason `local-host` on the local route", () => {
    restore = withDeps({ connectorRuntime: true })
    expect(resolveInboxWriteAvailability(INBOX_WRITE_COMMANDS.send)).toEqual({
      state: "available",
      reason: "local-host",
    })
  })

  it("is unsupported when nothing can execute the write", () => {
    restore = withDeps({})
    const availability = resolveInboxWriteAvailability(INBOX_WRITE_COMMANDS.send)
    expect(availability).toEqual({ state: "unsupported", reason: "requires-companion" })
    expect(canEnqueueInboxWrite(availability)).toBe(false)
  })

  it("is available when the active remote host advertises the command", () => {
    restore = withDeps({ remoteActive: true, manifest: manifest() })
    expect(resolveInboxWriteAvailability(INBOX_WRITE_COMMANDS.override)).toEqual({
      state: "available",
      reason: "local-host",
    })
  })

  it("is incompatible while the active remote host's manifest has not arrived", () => {
    restore = withDeps({ remoteActive: true, manifest: null })
    expect(resolveInboxWriteAvailability(INBOX_WRITE_COMMANDS.send)).toEqual({
      state: "incompatible",
      reason: "host-manifest-missing",
    })
  })

  it("is unsupported when the remote host predates the relay", () => {
    // A pre-ADR-0131 host: the feature is present but this operation is not.
    restore = withDeps({
      remoteActive: true,
      manifest: manifest(["connector_approve_draft"]),
    })
    expect(resolveInboxWriteAvailability(INBOX_WRITE_COMMANDS.send)).toEqual({
      state: "unsupported",
      reason: "operation-unavailable",
    })
  })

  it("requires a grant when the device was never granted workspace.write", () => {
    restore = withDeps({
      snapshot: snapshot({
        target: { kind: "companion", id: "host-1" } as RuntimeSnapshot["target"],
        host: {
          compatible: true,
          operations: [...INBOX_RELAY_HOST_OPERATIONS],
          grants: [],
        },
      }),
    })
    const availability = resolveInboxWriteAvailability(INBOX_WRITE_COMMANDS.send)
    expect(availability.state).toBe("requires-grant")
    expect(availability.requiredGrant).toBe(RELAY_CAPABILITY)
    expect(canEnqueueInboxWrite(availability)).toBe(false)
  })

  it("stays enqueueable for a companion target that is merely offline", () => {
    // Relay writes ride the durable queue, so "offline" must not block the
    // enqueue — the whole point is that the reply replays on reconnect.
    restore = withDeps({
      snapshot: companionSnapshot(INBOX_RELAY_HOST_OPERATIONS, { connectionState: "offline" }),
    })
    const availability = resolveInboxWriteAvailability(INBOX_WRITE_COMMANDS.send)
    expect(canEnqueueInboxWrite(availability)).toBe(true)
  })
})

describe("canEnqueueInboxWrite", () => {
  it.each(["available", "queued", "offline"] as const)("allows %s", (state) => {
    expect(canEnqueueInboxWrite({ state, reason: "local-host" })).toBe(true)
  })

  it.each(["unsupported", "incompatible", "requires-pairing", "requires-unlock"] as const)(
    "refuses %s",
    (state) => {
      expect(canEnqueueInboxWrite({ state, reason: "local-host" })).toBe(false)
    }
  )
})

describe("hostSupportsInboxRelay", () => {
  let restore: () => void = () => undefined
  afterEach(() => restore())

  it("is trivially true on a local connector host", () => {
    restore = withDeps({ connectorRuntime: true })
    expect(hostSupportsInboxRelay()).toBe(true)
  })

  it("is false standalone", () => {
    restore = withDeps({})
    expect(hostSupportsInboxRelay()).toBe(false)
  })

  it("reads the active remote host's feature manifest", () => {
    restore = withDeps({ remoteActive: true, manifest: manifest() })
    expect(hostSupportsInboxRelay()).toBe(true)
    restore()
    restore = withDeps({ remoteActive: true, manifest: null })
    expect(hostSupportsInboxRelay()).toBe(false)
  })

  it("reads the negotiated snapshot for a companion target", () => {
    restore = withDeps({ snapshot: companionSnapshot() })
    expect(hostSupportsInboxRelay()).toBe(true)
    restore()
    // Paired to a host that never heard of the relay.
    restore = withDeps({ snapshot: companionSnapshot(["claude_send"]) })
    expect(hostSupportsInboxRelay()).toBe(false)
  })

  it("is false when the companion host is protocol-incompatible", () => {
    restore = withDeps({
      snapshot: snapshot({
        target: { kind: "companion", id: "host-1" } as RuntimeSnapshot["target"],
        host: { compatible: false, operations: [...INBOX_RELAY_HOST_OPERATIONS], grants: [] },
      }),
    })
    expect(hostSupportsInboxRelay()).toBe(false)
  })
})

describe("remoteHostOperations", () => {
  let restore: () => void = () => undefined
  afterEach(() => restore())

  it("is null unless a remote host is actually being driven", () => {
    restore = withDeps({ connectorRuntime: true })
    expect(remoteHostOperations()).toBeNull()
  })

  it("flattens every feature's operations for a v1 manifest", () => {
    restore = withDeps({ remoteActive: true, manifest: manifest() })
    expect(remoteHostOperations()).toEqual([...INBOX_RELAY_HOST_OPERATIONS])
  })
})

describe("INBOX_WRITE_COMMANDS", () => {
  it("names the four relayed commands the host manifest advertises", () => {
    // The facade, the host manifest, and the Rust `KNOWN_COMMANDS` list have
    // to agree; this pins the TS half of that contract.
    for (const command of Object.values(INBOX_WRITE_COMMANDS)) {
      expect(INBOX_RELAY_HOST_OPERATIONS).toContain(command)
    }
  })
})
