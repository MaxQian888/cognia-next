jest.mock("@/lib/gateway/person-model-ticket", () => ({
  ...jest.requireActual("@/lib/gateway/person-model-ticket"),
  mintPersonModelTicket: jest.fn(),
}))
jest.mock("./build-options", () => ({
  resolveSendOptions: jest.fn(async (ctx) => ({
    model: ctx.personChat.model,
    providerCredentials: {
      apiKey: ctx.personChat.secret,
      baseURL: ctx.personChat.endpoint,
      protocol: "openai",
      apiFlavor: "chat",
    },
    toolSurface: "none",
    allowedTools: [],
    permissionMode: "plan",
    maxTurns: 1,
  })),
}))
import type { ChatSession } from "@cognia/agent-config-types"
import { mintPersonModelTicket } from "@/lib/gateway/person-model-ticket"
import { resolveSendOptions } from "./build-options"
import {
  forgetPersonChatTurn,
  personChatTerminalEvent,
  sendPersonChatTurn,
} from "./person-chat-turn"

const session = {
  id: "person-session",
  providerOverride: "anthropic",
  model: "org-model",
} as ChatSession
const ticket = {
  secret: "partition-ticket",
  endpoint: "http://127.0.0.1:9000/v1",
  expiresAt: Number.MAX_SAFE_INTEGER,
}

beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(mintPersonModelTicket)
    .mockReset()
    .mockResolvedValue(ticket as never)
})
afterEach(() => forgetPersonChatTurn(session.id))

it("resolves only a ticket and a deny-all capability grant", async () => {
  const dispatch = jest.fn(
    async (_options: import("@cognia/agent-config-types").SendOptions, _refreshed: boolean) => {}
  )
  await sendPersonChatTurn(session, dispatch)
  expect(mintPersonModelTicket).toHaveBeenCalledWith("anthropic", "org-model", session.id)
  expect(resolveSendOptions).toHaveBeenCalledWith({
    personChat: { model: "org-model", secret: ticket.secret, endpoint: ticket.endpoint },
    capabilityGrants: [
      expect.objectContaining({
        tools: { restrictTo: [] },
        mcpServers: { only: [] },
        subagents: { only: [] },
      }),
    ],
  })
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      toolSurface: "none",
      providerCredentials: expect.objectContaining({ protocol: "openai", apiFlavor: "chat" }),
    }),
    false
  )
  expect(dispatch.mock.calls[0][0]).not.toHaveProperty("cwd")
  expect(dispatch.mock.calls[0][0]).not.toHaveProperty("mcpServers")
})

it("re-mints an already expired ticket only once", async () => {
  jest.mocked(mintPersonModelTicket).mockResolvedValue({ ...ticket, expiresAt: 0 } as never)
  const dispatch = jest.fn(
    async (_options: import("@cognia/agent-config-types").SendOptions, _refreshed: boolean) => {}
  )
  await expect(sendPersonChatTurn(session, dispatch)).rejects.toMatchObject({
    code: "host_surface_forbidden",
  })
  expect(mintPersonModelTicket).toHaveBeenCalledTimes(2)
  expect(dispatch).not.toHaveBeenCalled()
})

it("refreshes a gateway 401 once per turn, then lets the error settle", async () => {
  const dispatch = jest.fn(
    async (_options: import("@cognia/agent-config-types").SendOptions, _refreshed: boolean) => {}
  )
  await sendPersonChatTurn(session, dispatch)
  const ended = {
    type: "session_ended" as const,
    sessionId: session.id,
    httpStatus: 401,
    error: "route ticket revoked",
  }
  await expect(personChatTerminalEvent(ended)).resolves.toBeNull()
  await expect(personChatTerminalEvent(ended)).resolves.toBe(ended)
  expect(mintPersonModelTicket).toHaveBeenCalledTimes(2)
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it("refreshes a synchronous Host refusal at most once", async () => {
  const dispatch = jest.fn(async () => {
    throw { code: "host_surface_forbidden" }
  })
  await expect(sendPersonChatTurn(session, dispatch)).rejects.toMatchObject({
    code: "host_surface_forbidden",
  })
  expect(mintPersonModelTicket).toHaveBeenCalledTimes(2)
})

it("surfaces a refused refresh with the Host code", async () => {
  await sendPersonChatTurn(session, async () => {})
  jest.mocked(mintPersonModelTicket).mockRejectedValue({ code: "model_access_unavailable" })
  await expect(
    personChatTerminalEvent({
      type: "session_ended",
      sessionId: session.id,
      error: "expired",
      httpStatus: 401,
    })
  ).resolves.toMatchObject({ error: "model_access_unavailable", code: "model_access_unavailable" })
})

it("never retries a reservation cap or a cancelled turn", async () => {
  await sendPersonChatTurn(session, async () => {})
  const cap = {
    type: "session_ended" as const,
    sessionId: session.id,
    error: "cap",
    code: "member_usage_cap_reached",
    httpStatus: 429,
    resetAt: 123,
  }
  await expect(personChatTerminalEvent(cap)).resolves.toBe(cap)
  expect(mintPersonModelTicket).toHaveBeenCalledTimes(1)
  await sendPersonChatTurn(session, async () => {})
  forgetPersonChatTurn(session.id)
  const expired = { ...cap, httpStatus: 401 }
  await expect(personChatTerminalEvent(expired)).resolves.toBe(expired)
  expect(mintPersonModelTicket).toHaveBeenCalledTimes(2)
})

it.each(["model_access_unavailable", "member_usage_cap_reached", "host_surface_forbidden"])(
  "does not retry a refused mint: %s",
  async (code) => {
    jest.mocked(mintPersonModelTicket).mockRejectedValue({ code, resetAt: 123 })
    const dispatch = jest.fn(async () => {})
    await expect(sendPersonChatTurn(session, dispatch)).rejects.toMatchObject({
      code,
      resetAt: 123,
    })
    expect(mintPersonModelTicket).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  }
)
