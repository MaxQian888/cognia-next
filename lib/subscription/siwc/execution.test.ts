import { configureSiwcAppServerConnection, configureSiwcChatConnection } from "./execution"
import { listSiwcConnections, listSiwcModels } from "./transport"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useAccountStore } from "@/stores/account/account-store"
import type { SiwcConnectionSummary } from "@/types/subscription/siwc"

jest.mock("./transport", () => ({ listSiwcConnections: jest.fn(), listSiwcModels: jest.fn() }))
jest.mock("@/lib/db", () => {
  const db = { name: "local-a-db" }
  return { getDb: jest.fn(() => db) }
})
jest.mock("@/stores/settings/settings-store", () => ({ useSettingsStore: { getState: jest.fn() } }))
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: { getState: jest.fn() },
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn() },
}))

const connection: SiwcConnectionSummary = {
  id: "registration-a",
  label: "Same account",
  email: "same@example.test",
  issuer: "https://auth.openai.com",
  subject: "subject-a",
  issuedClientId: "client-a",
  status: "connected",
  scopes: [],
  expiresAtMs: 1000,
  planPermission: true,
}
const addProvider = jest.fn()
const addAgent = jest.fn()
const close = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useAccountStore.getState).mockReturnValue({ unlockedAccountId: "local-a" } as never)
  jest.mocked(useAccountStore.subscribe).mockReturnValue(close)
  jest.mocked(useSettingsStore.getState).mockReturnValue({
    settings: { customProviders: [], defaultProvider: "codex", defaultAccountId: "legacy" },
    addCustomProvider: addProvider,
  } as never)
  jest.mocked(useExternalAgentStore.getState).mockReturnValue({ agents: {}, addAgent } as never)
  jest.mocked(listSiwcConnections).mockResolvedValue([connection])
  jest
    .mocked(listSiwcModels)
    .mockResolvedValue([{ slug: "model-a", displayName: "Model A", visibility: "list" }])
})

it("adds only an independent provider reference, leaving defaults and legacy credentials alone", async () => {
  await configureSiwcChatConnection(connection, "model-a")
  expect(addProvider).toHaveBeenCalledWith(
    expect.objectContaining({
      baseURL: "siwc://local-a/registration-a",
      apiKey: "",
      apiProtocol: "chatgpt-siwc",
      apiFlavor: "responses",
      customModels: ["model-a"],
    }),
    expect.objectContaining({ db: { name: "local-a-db" }, assertActive: expect.any(Function) })
  )
  expect(useSettingsStore.getState().settings).toEqual({
    customProviders: [],
    defaultProvider: "codex",
    defaultAccountId: "legacy",
  })
  expect(close).toHaveBeenCalledTimes(1)
})

it("converges concurrent chat setup requests on one provider entry", async () => {
  await Promise.all([
    configureSiwcChatConnection(connection, "model-a"),
    configureSiwcChatConnection(connection, "model-a"),
  ])
  // The settings mutation queue upserts by ID. Both requests must target the
  // same entry even before either queued write publishes its settings snapshot.
  expect(addProvider).toHaveBeenCalledTimes(2)
  expect(new Set(addProvider.mock.calls.map(([provider]) => provider.id)).size).toBe(1)
})

it("keeps provider entries distinct across registrations, models and local accounts", async () => {
  const other = { ...connection, id: "registration-b" }
  jest.mocked(listSiwcConnections).mockResolvedValue([connection, other])
  jest.mocked(listSiwcModels).mockResolvedValue([
    { slug: "model-a", displayName: "Model A", visibility: "list" },
    { slug: "model-b", displayName: "Model B", visibility: "list" },
  ])
  await Promise.all([
    configureSiwcChatConnection(connection, "model-a"),
    configureSiwcChatConnection(connection, "model-b"),
    configureSiwcChatConnection(other, "model-a"),
  ])
  jest.mocked(useAccountStore.getState).mockReturnValue({ unlockedAccountId: "local-b" } as never)
  await configureSiwcChatConnection(connection, "model-a")
  expect(addProvider).toHaveBeenCalledTimes(4)
  expect(new Set(addProvider.mock.calls.map(([provider]) => provider.id)).size).toBe(4)
})

it("adds an app-server configuration without spawning, connecting, or selecting it", async () => {
  await configureSiwcAppServerConnection(connection, "model-a")
  expect(addAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: "codex-siwc-app-server",
      enabled: false,
      metadata: {
        siwc: { localAccountId: "local-a", connectionId: "registration-a" },
        selectedModel: "model-a",
      },
    })
  )
  expect(addProvider).not.toHaveBeenCalled()
})

it("revalidates native plan permission rather than trusting a stale renderer summary", async () => {
  jest.mocked(listSiwcConnections).mockResolvedValue([{ ...connection, planPermission: false }])
  await expect(configureSiwcChatConnection(connection, "model-a")).rejects.toThrow("permission")
  expect(addProvider).not.toHaveBeenCalled()
})

it("refuses models outside the selected registration catalog", async () => {
  await expect(configureSiwcAppServerConnection(connection, "unlisted")).rejects.toThrow(
    "unavailable"
  )
  expect(addAgent).not.toHaveBeenCalled()
})

it("refuses catalog models that are not listed for selection", async () => {
  jest
    .mocked(listSiwcModels)
    .mockResolvedValue([{ slug: "model-a", displayName: "Internal model", visibility: "hide" }])
  await expect(configureSiwcChatConnection(connection, "model-a")).rejects.toThrow("unavailable")
  expect(addProvider).not.toHaveBeenCalled()
})

it("invalidates even an ABA switch while catalog validation is pending", async () => {
  let finish!: (value: Awaited<ReturnType<typeof listSiwcModels>>) => void
  jest.mocked(listSiwcModels).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const pending = configureSiwcChatConnection(connection, "model-a")
  await Promise.resolve()
  const listener = jest.mocked(useAccountStore.subscribe).mock.calls[0][0]
  listener({ unlockedAccountId: "local-b" } as never, {} as never)
  listener({ unlockedAccountId: "local-a" } as never, {} as never)
  finish([{ slug: "model-a", displayName: "Model A", visibility: "list" }])
  await expect(pending).rejects.toThrow("changed")
  expect(addProvider).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
})
