const start = jest.fn()
const get = jest.fn()
jest.mock("./core", () => ({ createBestOfNService: jest.fn(() => ({ startBestOfN: start })) }))
jest.mock("./host", () => ({ createBestOfNHost: jest.fn(() => ({ get })) }))
jest.mock("./runtime", () => ({ createBestOfNExecution: jest.fn(() => ({})) }))
jest.mock("./projection", () => ({ projectBestOfNGroup: jest.fn(), refreshBestOfNRun: jest.fn() }))
import { bestOfNService, startBestOfN } from "./service"
import { createBestOfNService } from "./core"
import { projectBestOfNGroup } from "./projection"

it("uses one shared entry and projects Host state without retrying committed writes", async () => {
  expect(bestOfNService()).toBe(bestOfNService())
  const request = {} as Parameters<typeof startBestOfN>[0]
  startBestOfN(request)
  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith(request)
  const host = jest.mocked(createBestOfNService).mock.calls[0][0].host
  const group = { groupId: "g", version: 1 }
  get.mockResolvedValue(group)
  await expect(host.get("g")).resolves.toEqual(group)
  expect(projectBestOfNGroup).toHaveBeenCalledWith(group)
  jest.mocked(projectBestOfNGroup).mockRejectedValueOnce(new Error("database offline"))
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  await expect(host.get("g")).resolves.toEqual(group)
  expect(warn).toHaveBeenCalled()
  warn.mockRestore()
})
