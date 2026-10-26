jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(), transport: { call: jest.fn() } }))
jest.mock("@cognia/provider-core/providers/magpie", () => ({ discoverMagpieModels: jest.fn() }))
import { isTauri, transport } from "@/lib/tauri"
import { discoverMagpieModels } from "@cognia/provider-core/providers/magpie"
import { discoverLocalMagpie } from "./client"
beforeEach(() => jest.resetAllMocks())
it("uses the native configured port rather than assuming the default", async () => {
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(transport.call).mockResolvedValue(18995)
  await discoverLocalMagpie()
  expect(transport.call).toHaveBeenCalledWith("magpie_gateway_port")
  expect(discoverMagpieModels).toHaveBeenCalledWith({
    baseURL: "http://127.0.0.1:18995/v1",
    signal: undefined,
  })
})
it("uses the documented default in a browser without invoking native commands", async () => {
  jest.mocked(isTauri).mockReturnValue(false)
  await discoverLocalMagpie()
  expect(transport.call).not.toHaveBeenCalled()
  expect(discoverMagpieModels).toHaveBeenCalledWith(
    expect.objectContaining({ baseURL: "http://127.0.0.1:3425/v1" })
  )
})
it("rejects malformed native ports before contacting the gateway", async () => {
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(transport.call).mockResolvedValue(0)
  await expect(discoverLocalMagpie()).rejects.toThrow(/port/)
  expect(discoverMagpieModels).not.toHaveBeenCalled()
})
