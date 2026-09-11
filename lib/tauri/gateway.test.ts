import { transport } from "@/lib/tauri"
import {
  gatewayCreateKey,
  gatewayDeleteKey,
  gatewayGetConfig,
  gatewayListCooldowns,
  gatewayListKeys,
  gatewayResetKeyQuota,
  gatewayResetCooldowns,
  gatewayPushSnapshot,
  gatewayGetStatus,
  gatewayUpdateConfig,
  gatewayStart,
  gatewayStop,
  gatewayProbeUpstream,
  gatewayMintRouteTicket,
  gatewayRevokeRouteTicket,
  gatewayListRouteTickets,
  gatewayDecisionResponse,
  gatewayRevealKey,
  gatewayUpdateKey,
} from "./gateway"
import { DEFAULT_GATEWAY_CONFIG, type GatewayMintRouteTicketRequest } from "@/types/gateway"
import * as flags from "@/lib/ai/agent/execution/feature-flags"
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  isAgentExecutionFlagEnabled: jest.fn(() => false),
}))

describe("lib/tauri/gateway", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("uses the host transport for listener control, configuration and upstream probes", async () => {
    const call = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    await gatewayGetStatus()
    await gatewayUpdateConfig(DEFAULT_GATEWAY_CONFIG)
    await gatewayStart()
    await gatewayStop()
    await gatewayProbeUpstream("fast")
    expect(call.mock.calls).toEqual([
      ["gateway_get_status"],
      ["gateway_update_config", { config: DEFAULT_GATEWAY_CONFIG }],
      ["gateway_start"],
      ["gateway_stop"],
      ["gateway_probe_upstream", { model: "fast" }],
    ])
  })

  it("mints an explicitly required route without the optional rollout flag", async () => {
    jest.mocked(flags.isAgentExecutionFlagEnabled).mockReturnValue(false)
    const call = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const request = {
      sessionId: "task",
      routePolicy: "gateway-required",
    } as GatewayMintRouteTicketRequest
    await gatewayMintRouteTicket(request, { required: true })
    expect(call).toHaveBeenCalledWith("gateway_mint_route_ticket", { request })
  })

  it("gates ticket minting and sends ticket lifecycle and routing responses to the host", async () => {
    const enabled = jest.mocked(flags.isAgentExecutionFlagEnabled).mockReturnValue(false)
    const call = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const request = {
      sessionId: "session",
      model: "fast",
    } as unknown as GatewayMintRouteTicketRequest
    await expect(gatewayMintRouteTicket(request)).rejects.toThrow("disabled")
    expect(call).not.toHaveBeenCalled()
    enabled.mockReturnValue(true)
    await gatewayMintRouteTicket(request)
    await gatewayRevokeRouteTicket("ticket")
    await gatewayListRouteTickets()
    await gatewayDecisionResponse("request", [])
    expect(call.mock.calls).toEqual([
      ["gateway_mint_route_ticket", { request }],
      ["gateway_revoke_route_ticket", { ticketId: "ticket" }],
      ["gateway_list_route_tickets"],
      ["gateway_decision_response", { requestId: "request", entries: [] }],
    ])
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

  it("lists upstream key cooldowns", async () => {
    const rows = [
      { providerId: "openai", keyHint: "…1234", untilMs: 0, permanent: true, reason: "quota" },
    ]
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(rows)
    await expect(gatewayListCooldowns()).resolves.toEqual(rows)
    expect(callSpy).toHaveBeenCalledWith("gateway_list_cooldowns")
  })

  it("sends the captured account context with a snapshot", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue({ accepted: true })
    const snapshot = { providers: [], aliases: [], generatedAtMs: 1 }
    await gatewayPushSnapshot(snapshot, { ownerAccountId: "local-a", accountGeneration: 4 })
    expect(callSpy).toHaveBeenCalledWith("gateway_push_snapshot", {
      snapshot,
      ownerAccountId: "local-a",
      accountGeneration: 4,
    })
  })

  it("resets all or one provider's upstream cooldowns", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(2)
    await expect(gatewayResetCooldowns()).resolves.toBe(2)
    expect(callSpy).toHaveBeenCalledWith("gateway_reset_cooldowns", { providerId: null })
    await gatewayResetCooldowns("opencode")
    expect(callSpy).toHaveBeenLastCalledWith("gateway_reset_cooldowns", { providerId: "opencode" })
  })
})
