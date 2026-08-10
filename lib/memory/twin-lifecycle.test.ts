import { invalidateTwinMemoryNamespace } from "./twin-lifecycle"

function deps() {
  const sink = { delete: jest.fn(async () => undefined) }
  return {
    sink,
    value: {
      list: jest.fn(async () => [
        { id: "m1", status: "active", vectorDocId: "v1" },
        { id: "m2", status: "invalidated", vectorDocId: "v2" },
      ]),
      invalidate: jest.fn(async () => undefined),
      audit: jest.fn(async () => undefined),
      buildSink: jest.fn(async () => sink),
    },
  }
}

it("de-indexes the Twin namespace before invalidating active memories", async () => {
  const d = deps()
  await expect(invalidateTwinMemoryNamespace("alice", d.value as never)).resolves.toBe(1)
  expect(d.value.list).toHaveBeenCalledWith({ scope: "agent", agentId: "twin:alice" })
  expect(d.sink.delete).toHaveBeenCalledWith(["v1", "v2"])
  expect(d.value.invalidate).toHaveBeenCalledWith("m1")
  expect(d.value.invalidate).not.toHaveBeenCalledWith("m2")
  expect(d.sink.delete.mock.invocationCallOrder[0]).toBeLessThan(
    d.value.invalidate.mock.invocationCallOrder[0]
  )
})

it("preserves memory rows when vector cleanup fails", async () => {
  const d = deps()
  d.sink.delete.mockRejectedValueOnce(new Error("offline"))
  await expect(invalidateTwinMemoryNamespace("alice", d.value as never)).rejects.toThrow("offline")
  expect(d.value.invalidate).not.toHaveBeenCalled()
})
