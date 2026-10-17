jest.mock("@/lib/task-workspace/user-action", () => ({
  approvalAwareTransport: { call: jest.fn() },
}))
import { createBestOfNHost } from "./host"

it("sends the CAS envelope without a caller-asserted selection origin", async () => {
  const call = jest.fn().mockResolvedValue({})
  const host = createBestOfNHost(call)
  const mutation = {
    groupId: "group",
    ownerId: "owner",
    expectedVersion: 3,
    leaseDurationMs: 30000,
  }
  await host.select({ mutation, candidateId: "winner", headSha: "head" })
  expect(call).toHaveBeenCalledWith("best_of_n_select", {
    input: { mutation, candidateId: "winner", headSha: "head" },
  })
  await host.recover(mutation)
  expect(call).toHaveBeenLastCalledWith("best_of_n_recover", { input: mutation })
})

it("maps all lifecycle commands to the Host catalog", async () => {
  const call = jest.fn().mockResolvedValue({})
  const host = createBestOfNHost(call)
  await host.get("g")
  await host.list()
  expect(call.mock.calls).toEqual([
    ["best_of_n_get", { groupId: "g" }],
    ["best_of_n_list", {}],
  ])
})

it("fails explicitly when the Host no longer has a group", async () => {
  await expect(createBestOfNHost(jest.fn().mockResolvedValue(null)).get("missing")).rejects.toThrow(
    "group not found"
  )
})
