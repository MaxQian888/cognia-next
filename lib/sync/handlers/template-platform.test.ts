import {
  syncTemplateDefinitions,
  syncTemplateInstances,
  syncTemplatePackages,
} from "./template-platform"
import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"

const database = {
  templateDefinitions: { bulkPut: jest.fn(), bulkDelete: jest.fn() },
  templatePackages: { bulkPut: jest.fn(), bulkDelete: jest.fn() },
  templateInstances: { bulkPut: jest.fn(), bulkDelete: jest.fn() },
}

jest.mock("@/lib/db/schema", () => ({
  // A real scoped database returns stable table objects. Recreating them for
  // every read correctly trips the sync handler's scope-change protection.
  getDb: () => database,
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
    await expect(handler(transport, { since: 3 })).resolves.toEqual({
      ok: true,
      result: { table, applied: 0, nextSince: 4 },
    })
    expect((transport as { call: jest.Mock }).call).toHaveBeenCalledWith("sync_pull", {
      table,
      since: 3,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
  })
})
