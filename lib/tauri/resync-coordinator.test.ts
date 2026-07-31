import { ResyncCoordinator } from "./resync-coordinator"

describe("ResyncCoordinator", () => {
  it("resolves each affected domain once", async () => {
    const coordinator = new ResyncCoordinator()
    const sync = jest.fn(async () => {})
    coordinator.register("claude", sync)

    await coordinator.resolve(["claude", "claude"])

    expect(sync).toHaveBeenCalledTimes(1)
    expect(coordinator.hasResolverForEvent("claude://message")).toBe(true)
  })

  it("uses a wildcard authoritative snapshot resolver", async () => {
    const coordinator = new ResyncCoordinator()
    const syncAll = jest.fn(async () => {})
    coordinator.register("*", syncAll)

    await coordinator.resolve(["claude", "workflow"])

    expect(syncAll).toHaveBeenCalledTimes(1)
    expect(coordinator.hasResolverForEvent("plugin:changed")).toBe(true)
  })

  it("rejects domains that cannot be recovered", async () => {
    const coordinator = new ResyncCoordinator()
    await expect(coordinator.resolve(["unknown"])).rejects.toThrow(
      "no authoritative resolver for 'unknown'"
    )
  })

  it("unregisters only the matching resolver", async () => {
    const coordinator = new ResyncCoordinator()
    const remove = coordinator.register("sync", async () => {})
    remove()
    await expect(coordinator.resolve(["sync"])).rejects.toThrow()
  })
})
