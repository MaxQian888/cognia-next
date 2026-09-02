/** @jest-environment node */
import { createProviderOperationPersistence } from "./persistence"

const row = {
  id: "deployment:d1",
  deploymentRef: "d1",
  providerRef: "openai",
  status: "healthy" as const,
  checkedAt: 1,
  availableUpstreamIds: [],
}

describe("provider operation persistence", () => {
  it("delegates to the catalog module and returns what it reads", async () => {
    const catalog = {
      getConnectionInventory: jest.fn(async () => row),
      putConnectionInventory: jest.fn(async () => undefined),
      putOperationSnapshots: jest.fn(async () => undefined),
    }
    const persistence = createProviderOperationPersistence(async () => catalog as never)
    await expect(persistence.readInventory("d1")).resolves.toEqual(row)
    await persistence.writeInventory(row)
    await persistence.writeSnapshots({
      providerId: "openai",
      deploymentRef: "d1",
      accountRef: "a",
      cells: [],
      computedAt: 1,
    })
    expect(catalog.putConnectionInventory).toHaveBeenCalledWith(row)
    expect(catalog.putOperationSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({ accountRef: "a" })
    )
    expect(persistence.lastError).toBeUndefined()
  })

  it("swallows a missing database and keeps the failure for diagnostics", async () => {
    const persistence = createProviderOperationPersistence(async () => {
      throw new Error("IndexedDB API missing")
    })
    await expect(persistence.readInventory("d1")).resolves.toBeUndefined()
    await expect(persistence.writeInventory(row)).resolves.toBeUndefined()
    expect(persistence.lastError).toBeInstanceOf(Error)
  })
})
