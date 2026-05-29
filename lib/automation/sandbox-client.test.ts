import { sandboxClient } from "@/lib/automation/sandbox-client"
import { transport } from "@/lib/tauri"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

const call = transport.call as jest.Mock

beforeEach(() => call.mockReset())

test("start invokes cua_sandbox_start with connectionId + image", async () => {
  call.mockResolvedValueOnce(49160)
  const port = await sandboxClient.start("c1", "ghcr.io/trycua/cua-xfce:latest")
  expect(call).toHaveBeenCalledWith("cua_sandbox_start", {
    connectionId: "c1",
    image: "ghcr.io/trycua/cua-xfce:latest",
  })
  expect(port).toBe(49160)
})

test("stop invokes cua_sandbox_stop", async () => {
  call.mockResolvedValueOnce(undefined)
  await sandboxClient.stop("c1")
  expect(call).toHaveBeenCalledWith("cua_sandbox_stop", { connectionId: "c1" })
})

test("health invokes cua_sandbox_health", async () => {
  call.mockResolvedValueOnce(true)
  expect(await sandboxClient.health("c1")).toBe(true)
  expect(call).toHaveBeenCalledWith("cua_sandbox_health", { connectionId: "c1" })
})
