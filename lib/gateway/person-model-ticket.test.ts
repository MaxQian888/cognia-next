jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
import { transport } from "@/lib/tauri"
import { mintPersonModelTicket, personChatFailure } from "./person-model-ticket"

it("mints through the partition transport without reading any credential store", async () => {
  const ticket = {
    ticketId: "ticket-id",
    secret: "ticket",
    endpoint: "http://127.0.0.1:9000/v1",
    gatewayPort: 9000,
    provider: "anthropic",
    model: "model",
    expiresAt: 123,
    credentialFingerprint: "fingerprint",
  }
  jest.mocked(transport.call).mockResolvedValue(ticket)
  await expect(mintPersonModelTicket("anthropic", "model", "session")).resolves.toBe(ticket)
  expect(transport.call).toHaveBeenCalledWith("person_model_ticket_mint", {
    provider: "anthropic",
    model: "model",
    sessionId: "session",
  })
})

it.each([
  [503, "model_access_unavailable"],
  [429, "member_usage_cap_reached"],
  [403, "host_surface_forbidden"],
])("preserves a %s refusal and only safe details", (_status, code) => {
  expect(personChatFailure({ code, resetAt: 123, body: "private", secret: "private" })).toEqual({
    code,
    resetAt: 123,
  })
})

it("refuses malformed or mismatched ticket responses before exposing a secret to any endpoint", async () => {
  jest.mocked(transport.call).mockResolvedValue({
    secret: "ticket",
    endpoint: "https://outside.example/v1",
    provider: "anthropic",
    model: "other-model",
  })
  await expect(mintPersonModelTicket("anthropic", "model", "session")).rejects.toMatchObject({
    code: "malformed_request",
  })
})
