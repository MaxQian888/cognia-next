import { transport } from "@/lib/tauri"
import { gatewayClearToken } from "./gateway"

describe("lib/tauri/gateway", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("delegates token clearing to the Tauri command", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(undefined)

    await gatewayClearToken()

    expect(callSpy).toHaveBeenCalledWith("gateway_clear_token")
  })
})
