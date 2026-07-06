import { transport } from "@/lib/tauri"
import {
  gatewayCreateKey,
  gatewayDeleteKey,
  gatewayGetConfig,
  gatewayListKeys,
  gatewayResetKeyQuota,
  gatewayRevealKey,
  gatewayUpdateKey,
} from "./gateway"

describe("lib/tauri/gateway", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("reads the persisted config", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce({ port: 47823 })
    await gatewayGetConfig()
    expect(callSpy).toHaveBeenCalledWith("gateway_get_config")
  })

  it("lists keys", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce([])
    await gatewayListKeys()
    expect(callSpy).toHaveBeenCalledWith("gateway_list_keys")
  })

  it("creates a scoped key with the expected payload including quota", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce({ id: "k1" })
    await gatewayCreateKey({
      name: "cli",
      modelAllowlist: ["fast"],
      expiresAtMs: 123,
      rateLimitPerMin: 60,
      quotaTokens: 100000,
    })
    expect(callSpy).toHaveBeenCalledWith("gateway_create_key", {
      name: "cli",
      modelAllowlist: ["fast"],
      expiresAtMs: 123,
      rateLimitPerMin: 60,
      quotaTokens: 100000,
    })
  })

  it("defaults an omitted quota to null", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce({ id: "k1" })
    await gatewayCreateKey({
      name: "cli",
      modelAllowlist: [],
      expiresAtMs: null,
      rateLimitPerMin: null,
    })
    expect(callSpy).toHaveBeenCalledWith(
      "gateway_create_key",
      expect.objectContaining({ quotaTokens: null })
    )
  })

  it("patches, reveals, resets quota, and deletes a key", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    await gatewayUpdateKey("k1", { enabled: false })
    expect(callSpy).toHaveBeenCalledWith("gateway_update_key", {
      id: "k1",
      patch: { enabled: false },
    })
    await gatewayRevealKey("k1")
    expect(callSpy).toHaveBeenCalledWith("gateway_reveal_key", { id: "k1" })
    await gatewayResetKeyQuota("k1")
    expect(callSpy).toHaveBeenCalledWith("gateway_reset_key_quota", { id: "k1" })
    await gatewayDeleteKey("k1")
    expect(callSpy).toHaveBeenCalledWith("gateway_delete_key", { id: "k1" })
  })
})
