import { getDb } from "@/lib/db/schema"

import { syncChatTemplates } from "./chat-templates"
import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"

jest.mock("@/lib/db/schema", () => {
  const chatTemplates = {
    bulkPut: jest.fn(async () => undefined),
    bulkDelete: jest.fn(async () => undefined),
  }
  return { getDb: () => ({ chatTemplates }) }
})

const mirror = (getDb() as unknown as { chatTemplates: Record<string, jest.Mock> }).chatTemplates

beforeEach(() => {
  mirror.bulkPut.mockClear()
  mirror.bulkDelete.mockClear()
})

describe("chat template mobile sync", () => {
  it("pulls the chatTemplates delta at the caller's cursor", async () => {
    const call = jest.fn(async () => ({ rows: [], deleted_ids: [], next_since: 7 }))

    const outcome = await syncChatTemplates({ call } as never, { since: 3 })

    expect(call).toHaveBeenCalledWith("sync_pull", {
      table: "chatTemplates",
      since: 3,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(outcome).toEqual({
      ok: true,
      result: { table: "chatTemplates", applied: 0, nextSince: 7 },
    })
  })

  it("applies rows and tombstones into the local mirror", async () => {
    // The tombstone half is not decoration: a template deleted on the desktop
    // has to stop being offered by the `/` menu, or the phone keeps inserting
    // text from something the user removed.
    const row = { id: "tpl_a", name: "Standup", body: "hi", updatedAt: 9 }
    const call = jest.fn(async () => ({
      rows: [row],
      deleted_ids: ["tpl_gone"],
      next_since: 9,
    }))

    const outcome = await syncChatTemplates({ call } as never, { since: 0 })

    expect(mirror.bulkPut).toHaveBeenCalledWith([row])
    expect(mirror.bulkDelete).toHaveBeenCalledWith(["tpl_gone"])
    expect(outcome).toEqual({
      ok: true,
      result: { table: "chatTemplates", applied: 2, nextSince: 9 },
    })
  })
})
