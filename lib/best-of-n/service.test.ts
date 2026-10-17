const start = jest.fn()
jest.mock("./core", () => ({ createBestOfNService: jest.fn(() => ({ startBestOfN: start })) }))
jest.mock("./host", () => ({ createBestOfNHost: jest.fn(() => ({})) }))
jest.mock("./runtime", () => ({ createBestOfNExecution: jest.fn(() => ({})) }))
import { bestOfNService, startBestOfN } from "./service"

it("uses one shared entry for both future send surfaces", () => {
  expect(bestOfNService()).toBe(bestOfNService())
  const request = {} as Parameters<typeof startBestOfN>[0]
  startBestOfN(request)
  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith(request)
})
