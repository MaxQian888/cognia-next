import {
  syncTemplateDefinitions,
  syncTemplateInstances,
  syncTemplatePackages,
} from "./template-platform"

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    templateDefinitions: { bulkPut: jest.fn(), bulkDelete: jest.fn() },
    templatePackages: { bulkPut: jest.fn(), bulkDelete: jest.fn() },
    templateInstances: { bulkPut: jest.fn(), bulkDelete: jest.fn() },
  }),
}))

describe("template platform mobile sync", () => {
  it.each([
    ["templateDefinitions", syncTemplateDefinitions],
    ["templatePackages", syncTemplatePackages],
    ["templateInstances", syncTemplateInstances],
  ] as const)("pulls the portable %s projection", async (table, handler) => {
    const transport = {
      call: jest.fn(async () => ({ rows: [], deleted_ids: [], next_since: 4 })),
    } as never
    await handler(transport, { since: 3 })
    expect((transport as { call: jest.Mock }).call).toHaveBeenCalledWith("sync_pull", {
      table,
      since: 3,
    })
  })
})
