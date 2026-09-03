import {
  HOST_CONFIG_COMMANDS,
  HostConfigsUnsupportedError,
  admitRemoteExternalRun,
  createRemoteHostConfig,
  deleteRemoteHostConfig,
  getRemoteHostConfig,
  hostConfigsAvailability,
  hostOwnsExternalAgentConfigs,
  listRemoteHostConfigs,
  reconcileRemoteHostConfigs,
  releaseRemoteExternalRun,
  updateRemoteHostConfig,
  __setRemoteHostConfigDepsForTests,
  type RemoteHostConfigDeps,
} from "./remote-host-configs"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"

const ALL_OPS = Object.values(HOST_CONFIG_COMMANDS)

function manifest(operations: readonly string[] = ALL_OPS): HostFeatureManifest {
  return {
    schemaVersion: 1,
    features: { "external-agent.host-configs": { version: 1, operations: [...operations] } },
  } as unknown as HostFeatureManifest
}

function snapshot(host: unknown) {
  return () => ({ host }) as ReturnType<RemoteHostConfigDeps["getRuntimeSnapshot"]>
}

let restore: (() => void) | undefined
const calls: Array<{ command: string; payload?: Record<string, unknown> }> = []
const leaseOperations: string[][] = []

function setup(over: Partial<RemoteHostConfigDeps> = {}, reply: unknown = {}) {
  calls.length = 0
  leaseOperations.length = 0
  restore?.()
  restore = __setRemoteHostConfigDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalAuthority: () => false,
    activeHostFeatureManifest: () => null,
    getRuntimeSnapshot: snapshot({ compatible: true, operations: ALL_OPS }),
    call: async (command, payload) => {
      calls.push({ command, payload })
      return reply as never
    },
    issueAdminLease: async (operations) => {
      leaseOperations.push(operations)
      return { token: "lease-1", operations, expiresAt: Date.now() + 60_000 }
    },
    ...over,
  })
}

afterEach(() => {
  restore?.()
  restore = undefined
})

describe("hostConfigsAvailability", () => {
  it("is available on a shell that owns its own store", () => {
    setup({ hasLocalAuthority: () => true })
    expect(hostConfigsAvailability()).toEqual({ ok: true })
    expect(hostOwnsExternalAgentConfigs()).toBe(true)
  })

  // A desktop driving a remote host must ask the REMOTE host, even though its
  // own shell could spawn: the run happens over there.
  it("consults the remote manifest when a desktop drives a remote host", () => {
    setup({
      hasLocalAuthority: () => true,
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest([]),
    })
    expect(hostConfigsAvailability()).toEqual({ ok: false, reason: "unsupported" })
  })

  it("reports a manifest that has not arrived yet as its own reason", () => {
    setup({ isRemoteHostActive: () => true, activeHostFeatureManifest: () => null })
    expect(hostConfigsAvailability()).toEqual({ ok: false, reason: "manifest-missing" })
  })

  it("reports no host at all", () => {
    setup({ getRuntimeSnapshot: snapshot(undefined) })
    expect(hostConfigsAvailability()).toEqual({ ok: false, reason: "no-host" })
    expect(hostOwnsExternalAgentConfigs()).toBe(false)
  })

  it("reports an incompatible companion host as unsupported", () => {
    setup({ getRuntimeSnapshot: snapshot({ compatible: false, operations: ALL_OPS }) })
    expect(hostConfigsAvailability()).toEqual({ ok: false, reason: "unsupported" })
  })

  // Per operation, not per feature: a host may ship the store before admission.
  it("answers per operation on a companion target", () => {
    setup({
      getRuntimeSnapshot: snapshot({
        compatible: true,
        operations: [HOST_CONFIG_COMMANDS.list],
      }),
    })
    expect(hostConfigsAvailability(HOST_CONFIG_COMMANDS.list)).toEqual({ ok: true })
    expect(hostConfigsAvailability(HOST_CONFIG_COMMANDS.admit)).toEqual({
      ok: false,
      reason: "unsupported",
    })
  })

  it("answers per operation on a remote host manifest", () => {
    setup({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest([HOST_CONFIG_COMMANDS.list]),
    })
    expect(hostConfigsAvailability(HOST_CONFIG_COMMANDS.list)).toEqual({ ok: true })
    expect(hostConfigsAvailability(HOST_CONFIG_COMMANDS.update)).toEqual({
      ok: false,
      reason: "unsupported",
    })
  })

  it("treats a companion advertising none of the commands as unsupported", () => {
    setup({ getRuntimeSnapshot: snapshot({ compatible: true, operations: ["something_else"] }) })
    expect(hostConfigsAvailability()).toEqual({ ok: false, reason: "unsupported" })
  })
})

describe("the refusal is structured and never a fallback", () => {
  it("throws rather than degrading when the host cannot do it", async () => {
    setup({ getRuntimeSnapshot: snapshot(undefined) })
    await expect(listRemoteHostConfigs()).rejects.toBeInstanceOf(HostConfigsUnsupportedError)
    // Nothing was attempted: silently running the turn somewhere else is the
    // exact failure mode the host-owned store exists to prevent.
    expect(calls).toEqual([])
  })

  it("names the feature and the operation it refused", async () => {
    setup({ getRuntimeSnapshot: snapshot({ compatible: true, operations: [] }) })
    await expect(reconcileRemoteHostConfigs()).rejects.toMatchObject({
      name: "HostConfigsUnsupportedError",
      reason: "unsupported",
      feature: "external-agent.host-configs",
      operation: HOST_CONFIG_COMMANDS.reconcile,
    })
    expect(leaseOperations).toEqual([])
  })

  it("distinguishes an unpaired client from an outdated host in its message", () => {
    expect(new HostConfigsUnsupportedError("no-host").message).toMatch(/No paired host/)
    expect(new HostConfigsUnsupportedError("manifest-missing").message).toMatch(/not reported/)
    expect(
      new HostConfigsUnsupportedError("unsupported", HOST_CONFIG_COMMANDS.admit).message
    ).toMatch(/external_agent_admit_run/)
  })
})

describe("commands", () => {
  it("lists", async () => {
    setup({ hasLocalAuthority: () => true }, { configs: [{ configId: "eac_1" }] })
    await expect(listRemoteHostConfigs()).resolves.toEqual([{ configId: "eac_1" }])
    expect(calls[0].command).toBe(HOST_CONFIG_COMMANDS.list)
  })

  it("tolerates a host that answers a list with nothing", async () => {
    setup({ hasLocalAuthority: () => true }, {})
    await expect(listRemoteHostConfigs()).resolves.toEqual([])
    await expect(reconcileRemoteHostConfigs()).resolves.toEqual([])
  })

  it("gets", async () => {
    setup({ hasLocalAuthority: () => true }, { config: null })
    await expect(getRemoteHostConfig("eac_1")).resolves.toBeNull()
    expect(calls[0]).toEqual({
      command: HOST_CONFIG_COMMANDS.get,
      payload: { configId: "eac_1" },
    })
  })

  it("creates without an import flag by default", async () => {
    setup({ hasLocalAuthority: () => true }, { config: { configId: "eac_1" } })
    await createRemoteHostConfig({ name: "Pi" })
    expect(calls[0].payload).toEqual({ config: { name: "Pi" } })
  })

  it("passes the import flag through so the host does the scrubbing", async () => {
    setup({ hasLocalAuthority: () => true }, { config: { configId: "eac_1" } })
    await createRemoteHostConfig({ name: "Pi" }, { fromImport: true })
    expect(calls[0].payload).toEqual({ config: { name: "Pi" }, fromImport: true })
  })

  it("updates with the revision the caller last read", async () => {
    setup({ hasLocalAuthority: () => true }, { config: { configId: "eac_1" } })
    await updateRemoteHostConfig({
      configId: "eac_1",
      expectedRevision: "eacr_1",
      patch: { name: "Renamed" },
    })
    expect(calls[0].payload).toEqual({
      configId: "eac_1",
      expectedRevision: "eacr_1",
      patch: { name: "Renamed" },
    })
  })

  it("deletes", async () => {
    setup({ hasLocalAuthority: () => true }, { config: { configId: "eac_1" } })
    await deleteRemoteHostConfig("eac_1")
    expect(calls[0]).toEqual({
      command: HOST_CONFIG_COMMANDS.delete,
      payload: { configId: "eac_1" },
    })
  })

  it("uses a fresh approval lease for a remote write", async () => {
    setup(
      {
        hasLocalAuthority: () => false,
        getRuntimeSnapshot: snapshot({ compatible: true, operations: ALL_OPS }),
      },
      { config: { configId: "eac_1" } }
    )

    await updateRemoteHostConfig({
      configId: "eac_1",
      expectedRevision: "eacr_1",
      patch: { enabled: false },
    })

    expect(leaseOperations).toEqual([[HOST_CONFIG_COMMANDS.update]])
    expect(calls[0].payload).toEqual({
      configId: "eac_1",
      expectedRevision: "eacr_1",
      patch: { enabled: false },
      adminLease: "lease-1",
    })
  })
})

describe("run admission", () => {
  const stamp = { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 3 }

  it("sends the stamp and reports an admission", async () => {
    setup({ hasLocalAuthority: () => true }, { admitted: true, record: { configId: "eac_1" } })
    await expect(admitRemoteExternalRun("run-1", stamp)).resolves.toEqual({
      admitted: true,
      runId: "run-1",
      record: { configId: "eac_1" },
    })
    expect(calls[0]).toEqual({
      command: HOST_CONFIG_COMMANDS.admit,
      payload: { runId: "run-1", stamp },
    })
  })

  it("surfaces the host's refusal as data", async () => {
    setup(
      { hasLocalAuthority: () => true },
      { admitted: false, refusal: { kind: "config", reason: "stale-revision" } }
    )
    await expect(admitRemoteExternalRun("run-1", stamp)).resolves.toMatchObject({
      admitted: false,
      refusal: { kind: "config", reason: "stale-revision" },
    })
  })

  // A host that says `admitted` with no record has told us nothing checkable,
  // so it is treated as a refusal rather than trusted.
  it("refuses an admission that carries no record", async () => {
    setup({ hasLocalAuthority: () => true }, { admitted: true })
    const result = await admitRemoteExternalRun("run-1", stamp)
    expect(result.admitted).toBe(false)
  })

  // Admission is `interactive` like every sibling write. It was declared
  // `signed-policy` and called bare, so a paired browser could never get past
  // it: the host answered "an active host policy is required" and nothing in
  // the product mints a host policy.
  it("carries an approval lease when a paired client admits a run", async () => {
    setup({ hasLocalAuthority: () => false }, { admitted: true, record: { configId: "eac_1" } })

    await admitRemoteExternalRun("run-1", stamp)

    expect(leaseOperations).toEqual([[HOST_CONFIG_COMMANDS.admit]])
    expect(calls[0].payload).toEqual({ runId: "run-1", stamp, adminLease: "lease-1" })
  })

  it("releases the lease", async () => {
    setup({ hasLocalAuthority: () => true }, { released: true })
    await releaseRemoteExternalRun("run-1")
    expect(calls[0]).toEqual({
      command: HOST_CONFIG_COMMANDS.release,
      payload: { runId: "run-1" },
    })
  })

  // The settle path runs when the turn has already failed, often because the
  // host is unreachable. Throwing there would replace the real failure.
  it("swallows a release failure", async () => {
    setup({
      hasLocalAuthority: () => true,
      call: async () => {
        throw new Error("host gone")
      },
    })
    await expect(releaseRemoteExternalRun("run-1")).resolves.toBeUndefined()
  })

  it("swallows a release refused by the handshake", async () => {
    setup({ getRuntimeSnapshot: snapshot(undefined) })
    await expect(releaseRemoteExternalRun("run-1")).resolves.toBeUndefined()
  })
})
