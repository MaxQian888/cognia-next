const enqueue = jest.fn(async (_input: unknown) => ({}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: (input: unknown) => enqueue(input) }))

import { queueCogsetActivation, queueInstallOriginRecord } from "./remote"

describe("cogset remote writes", () => {
  beforeEach(() => enqueue.mockClear())

  it("queues a cogset switch for the host", async () => {
    await queueCogsetActivation("writing")
    expect(enqueue).toHaveBeenCalledWith({
      command: "plugin_cogset_activate",
      payload: { cogsetId: "writing" },
      label: "plugin_cogset_activate:writing",
    })
  })

  it("queues an install origin for the host", async () => {
    const record = {
      pluginId: "tools",
      version: "1.0.0",
      origin: { kind: "builtin" as const },
      recordedAt: 1,
    }
    await queueInstallOriginRecord(record)
    expect(enqueue).toHaveBeenCalledWith({
      command: "plugin_install_origin_record",
      payload: { record },
      label: "plugin_install_origin_record:tools",
    })
  })
})
