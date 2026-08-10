const mockCreateTwinJob = jest.fn(async (draft) => ({ id: "job-1", ...draft }))
const mockRegisterTwinSource = jest.fn()

jest.mock("@/lib/db/twin-jobs", () => ({
  createTwinJob: (draft: unknown) => mockCreateTwinJob(draft),
}))
jest.mock("./source-registration", () => ({
  registerTwinSource: (draft: unknown) => mockRegisterTwinSource(draft),
}))

import { enqueueIngestJob, registerTwinSource } from "./index"

it("queues the public ingest operation with the canonical kind", async () => {
  await expect(enqueueIngestJob({ twinId: "twin-1", sourceIds: ["source-1"] })).resolves.toEqual(
    expect.objectContaining({ id: "job-1", kind: "ingest" })
  )
  expect(mockCreateTwinJob).toHaveBeenCalledWith({
    twinId: "twin-1",
    sourceIds: ["source-1"],
    kind: "ingest",
  })
})

it("exposes the transactional source-registration seam", () => {
  registerTwinSource({ twinId: "twin-1" } as never)
  expect(mockRegisterTwinSource).toHaveBeenCalledWith({ twinId: "twin-1" })
})
