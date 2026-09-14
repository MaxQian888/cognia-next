/** @jest-environment node */
import { connectGithubAccountFromSecret } from "./github-account-setup"
import { isHeadlessHost } from "@/lib/platform/detect"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { createIntegrationAccount, listIntegrationAccounts } from "@/lib/db/integrations"
import { getProvider, getSession } from "@/lib/plugin/auth/auth-provider-registry"
import { getRegisteredIntegration } from "./registry"
import { checkIntegrationAccountHealth } from "./providers"

jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: jest.fn() }))
jest.mock("@/lib/credentials/keyring-store", () => ({ createKeyringStore: jest.fn() }))
jest.mock("@/lib/db/integrations", () => ({
  createIntegrationAccount: jest.fn(),
  listIntegrationAccounts: jest.fn(),
}))
jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({
  getProvider: jest.fn(),
  getSession: jest.fn(),
}))
jest.mock("./registry", () => ({ getRegisteredIntegration: jest.fn() }))
jest.mock("./providers", () => ({ checkIntegrationAccountHealth: jest.fn() }))

const input = { operationId: "55555555-5555-4555-8555-555555555555", expectedLogin: "MaxQian888" }
const key = `setup:${input.operationId}`
const secret = "test-secret-never-returned"
let value: string | null
const store = { load: jest.fn(), save: jest.fn(), delete: jest.fn() }
const resolve = jest.fn()
const request = jest.fn()
const account = {
  id: "account",
  authSessionId: "session",
  providerId: "github-pat",
  remoteAccountId: "MaxQian888",
}
const provider = { id: "github-pat", pluginId: null, resolveRequestCredential: resolve }

beforeEach(() => {
  jest.resetAllMocks()
  value = JSON.stringify({ token: secret, accountLabel: "MaxQian888" })
  store.load.mockImplementation(async () => value)
  store.save.mockImplementation(async (_key, next) => {
    value = next
  })
  jest.mocked(isHeadlessHost).mockReturnValue(true)
  jest.mocked(createKeyringStore).mockReturnValue(store as never)
  jest
    .mocked(getRegisteredIntegration)
    .mockReturnValue({ definition: { authStrategies: [{ providerId: "github-pat" }] } } as never)
  jest.mocked(getProvider).mockReturnValue(provider as never)
  jest.mocked(getSession).mockResolvedValue({ id: "session" } as never)
  jest.mocked(listIntegrationAccounts).mockResolvedValue([])
  jest.mocked(createIntegrationAccount).mockImplementation(async () => {
    jest.mocked(listIntegrationAccounts).mockResolvedValue([account] as never)
    return account as never
  })
  jest.mocked(checkIntegrationAccountHealth).mockResolvedValue({ health: "healthy" } as never)
  resolve.mockResolvedValue({ accessToken: secret })
  request.mockResolvedValue({ ok: true, json: async () => ({ login: "MaxQian888" }) })
  global.fetch = request
})

it("consumes only the encrypted reference, verifies identity, checkpoints and scrubs the receipt", async () => {
  const result = await connectGithubAccountFromSecret(input)
  expect(result).toEqual({ accountId: "account", login: "MaxQian888", health: "healthy" })
  expect(createKeyringStore).toHaveBeenCalledWith("integration-github-credentials")
  expect(store.load).toHaveBeenCalledWith(key)
  expect(getSession).toHaveBeenCalledWith(
    "github-pat",
    ["repo"],
    expect.objectContaining({
      forceNewSession: true,
      configuration: { token: secret, accountLabel: "MaxQian888" },
    })
  )
  expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(createIntegrationAccount).mock.invocationCallOrder[0]
  )
  expect(request).toHaveBeenCalledWith(
    "https://api.github.com/user",
    expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ authorization: `Bearer ${secret}` }),
    })
  )
  expect(createIntegrationAccount).toHaveBeenCalledWith(
    "github-delivery",
    expect.objectContaining({
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "session",
    })
  )
  expect(JSON.parse(value!)).toEqual({
    accountLabel: "MaxQian888",
    authSessionId: "session",
    accountId: "account",
  })
  expect(JSON.stringify(result)).not.toContain("session")
  expect(JSON.stringify(result)).not.toContain(secret)
})

it("serializes concurrent setup and replays from persisted receipts without duplicate accounts", async () => {
  await Promise.all([connectGithubAccountFromSecret(input), connectGithubAccountFromSecret(input)])
  await connectGithubAccountFromSecret(input)
  expect(createIntegrationAccount).toHaveBeenCalledTimes(1)
  expect(getSession).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledTimes(3)
})

it("recovers a crash after session creation or account creation and retries failed health", async () => {
  value = JSON.stringify({ accountLabel: "MaxQian888", authSessionId: "session" })
  jest.mocked(checkIntegrationAccountHealth).mockRejectedValueOnce(new Error(secret))
  await expect(connectGithubAccountFromSecret(input)).rejects.not.toThrow(secret)
  await expect(connectGithubAccountFromSecret(input)).resolves.toMatchObject({
    accountId: "account",
  })
  expect(getSession).not.toHaveBeenCalled()
  expect(createIntegrationAccount).toHaveBeenCalledTimes(1)
})

it("reconciles an uncertain account creation from its checkpoint before retrying", async () => {
  jest.mocked(createIntegrationAccount).mockImplementationOnce(async () => {
    jest.mocked(listIntegrationAccounts).mockResolvedValue([account] as never)
    throw new Error("connection lost after account write")
  })
  await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("setup failed")
  expect(JSON.parse(value!)).toMatchObject({ authSessionId: "session" })
  await expect(connectGithubAccountFromSecret(input)).resolves.toMatchObject({
    accountId: "account",
  })
  expect(createIntegrationAccount).toHaveBeenCalledTimes(1)
  expect(getSession).toHaveBeenCalledTimes(1)
})

it("denies browser execution and caller-controlled secrets, providers or namespaces", async () => {
  jest.mocked(isHeadlessHost).mockReturnValue(false)
  await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("owning Headless")
  jest.mocked(isHeadlessHost).mockReturnValue(true)
  for (const extra of [{ token: secret }, { namespace: "other" }, { providerId: "other" }])
    await expect(connectGithubAccountFromSecret({ ...input, ...extra })).rejects.toThrow()
  await expect(
    connectGithubAccountFromSecret({ ...input, operationId: "../pat:session" })
  ).rejects.toThrow()
  expect(store.load).not.toHaveBeenCalled()
})

it.each([
  undefined,
  { pluginId: "other-plugin", resolveRequestCredential: resolve },
  { pluginId: null },
])("refuses missing or plugin-owned credential resolvers", async (candidate) => {
  jest.mocked(getProvider).mockReturnValue(candidate as never)
  await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("setup failed")
  expect(store.load).not.toHaveBeenCalled()
})

it.each([undefined, { definition: { authStrategies: [] } }])(
  "requires the registered GitHub integration strategy",
  async (definition) => {
    jest.mocked(getRegisteredIntegration).mockReturnValue(definition as never)
    await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("setup failed")
  }
)

it.each([
  null,
  "invalid-json",
  JSON.stringify({ accountLabel: "another", token: secret }),
  JSON.stringify({ accountLabel: "MaxQian888" }),
])("rejects missing or invalid staging without creating an account", async (staged) => {
  value = staged
  await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("setup failed")
  expect(createIntegrationAccount).not.toHaveBeenCalled()
})

it.each([
  { ok: false },
  { ok: true, json: async () => ({ login: "another" }) },
  { ok: true, json: async () => ({ login: 1 }) },
])("verifies live identity before creating accounts", async (response) => {
  request.mockResolvedValue(response)
  await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("setup failed")
  expect(createIntegrationAccount).not.toHaveBeenCalled()
})

it("sanitizes session and network failures and allows the queued retry", async () => {
  jest.mocked(getSession).mockResolvedValueOnce(undefined)
  const failed = connectGithubAccountFromSecret(input)
  const succeeding = connectGithubAccountFromSecret(input)
  await expect(failed).rejects.toThrow("setup failed")
  await expect(succeeding).resolves.toMatchObject({ accountId: "account" })
  request.mockRejectedValueOnce(new Error(`Authorization Bearer ${secret}`))
  await expect(connectGithubAccountFromSecret(input)).rejects.not.toThrow(secret)
})

it.each([
  { ...account, providerId: "other" },
  { ...account, remoteAccountId: "other" },
  { ...account, remoteAccountId: undefined },
])("rejects account ownership changes after checkpoint", async (existing) => {
  value = JSON.stringify({ accountLabel: "MaxQian888", authSessionId: "session" })
  jest.mocked(listIntegrationAccounts).mockResolvedValue([existing] as never)
  await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("setup failed")
  expect(createIntegrationAccount).not.toHaveBeenCalled()
})

it("never recreates removed accounts from successful receipts", async () => {
  value = JSON.stringify({
    accountLabel: "MaxQian888",
    authSessionId: "session",
    accountId: "removed",
  })
  await expect(connectGithubAccountFromSecret(input)).rejects.toThrow("setup failed")
  expect(createIntegrationAccount).not.toHaveBeenCalled()
})
