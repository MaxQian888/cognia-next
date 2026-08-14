import { PluginActivationConflictError, PluginLifecycleCoordinator } from "./lifecycle-coordinator"

describe("PluginLifecycleCoordinator", () => {
  it("allows only one manager generation to own a plugin at a time", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.acquire("manager-a", "example")

    expect(() => coordinator.acquire("manager-b", "example")).toThrow(PluginActivationConflictError)
    expect(coordinator.isCurrent(first)).toBe(true)

    coordinator.release(first)
    const second = coordinator.acquire("manager-b", "example")
    expect(second.generation).toBeGreaterThan(first.generation)
  })

  it("does not let an old generation release the current owner", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.acquire("manager-a", "example")
    coordinator.release(first)
    const second = coordinator.acquire("manager-a", "example")

    coordinator.release(first)

    expect(coordinator.isCurrent(second)).toBe(true)
  })

  it("blocks dependent admission while a provider is draining", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const reservation = coordinator.reserveProviderDrain("manager-a", "provider")

    expect(() => coordinator.assertProvidersAccepting(["provider"])).toThrow(
      "Plugin dependency provider is draining"
    )
    coordinator.releaseProviderDrain(reservation)
    expect(() => coordinator.assertProvidersAccepting(["provider"])).not.toThrow()
  })

  it("does not let a stale graph reservation release a newer one", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.reserveProviderDrain("manager-a", "provider")
    coordinator.releaseProviderDrain(first)
    const second = coordinator.reserveProviderDrain("manager-a", "provider")

    expect(coordinator.releaseProviderDrain(first)).toBe(false)
    expect(coordinator.isProviderDraining("provider")).toBe(true)
    expect(coordinator.releaseProviderDrain(second)).toBe(true)
  })

  it("publishes redacted lifecycle snapshots to subscribers", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const seen: string[][] = []
    coordinator.subscribe((snapshot) => seen.push(snapshot.map((entry) => entry.pluginId)))
    const lease = coordinator.acquire("manager-a", "example")

    expect(
      coordinator.updateSnapshot({
        managerId: "manager-a",
        pluginId: "example",
        generation: lease.generation,
        intent: "enabled",
        actual: "active",
        stateSince: 123,
        requiredServices: ["workspace.backend"],
        providedServices: [],
        currentProviders: ["workspace.backend:workspace"],
        effects: { active: 2, pending: 0, failed: 0, labels: ["ctx.events.on"] },
        dirty: {
          runtime: "node",
          reason: "error",
          at: 123,
          message: "x".repeat(1_000),
          runtimeGeneration: "g".repeat(200),
          labels: Array.from({ length: 30 }, (_, index) => `effect-${index}`),
        },
      })
    ).toBe(true)

    expect(coordinator.getSnapshot("example")).toMatchObject({
      actual: "active",
      generation: lease.generation,
      effects: { active: 2 },
      dirty: {
        message: "x".repeat(512),
        runtimeGeneration: "g".repeat(128),
        labels: expect.arrayContaining(["effect-0"]),
      },
    })
    expect(coordinator.getSnapshot("example")?.dirty?.labels).toHaveLength(20)
    expect(seen.at(-1)).toEqual(["example"])
  })

  it("rejects a stale generation snapshot update", () => {
    const coordinator = new PluginLifecycleCoordinator()
    const first = coordinator.acquire("manager-a", "example")
    coordinator.release(first)
    const second = coordinator.acquire("manager-a", "example")

    expect(
      coordinator.updateSnapshot({
        managerId: "manager-a",
        pluginId: "example",
        generation: first.generation,
        intent: "enabled",
        actual: "error",
        stateSince: 1,
        requiredServices: [],
        providedServices: [],
        currentProviders: [],
        effects: { active: 0, pending: 0, failed: 0, labels: [] },
      })
    ).toBe(false)
    expect(coordinator.get("example")).toEqual(second)
  })
})
