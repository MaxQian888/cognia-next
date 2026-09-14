/** Headless account setup consumes a fixed encrypted reference, never a token-bearing RPC. */
import { z } from "zod"
import { isHeadlessHost } from "@/lib/platform/detect"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { createIntegrationAccount, listIntegrationAccounts } from "@/lib/db/integrations"
import { getProvider, getSession } from "@/lib/plugin/auth/auth-provider-registry"
import { getRegisteredIntegration } from "./registry"
import { checkIntegrationAccountHealth } from "./providers"

const pluginId = "github-delivery"
const integrationId = "github"
const providerId = "github-pat"
const login = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/)
const inputSchema = z.object({ operationId: z.string().uuid(), expectedLogin: login }).strict()
const stagingSchema = z
  .object({
    accountLabel: login,
    token: z.string().min(1).optional(),
    authSessionId: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
  })
  .strict()
const active = new Map<string, Promise<SetupResult>>()
interface SetupResult {
  accountId: string
  login: string
  health: string
}

async function connect(input: z.infer<typeof inputSchema>): Promise<SetupResult> {
  const integration = getRegisteredIntegration(pluginId, integrationId)
  const provider = getProvider(providerId)
  if (
    !integration?.definition.authStrategies.some(
      (strategy) => strategy.providerId === providerId
    ) ||
    !provider ||
    provider.pluginId !== null ||
    !provider.resolveRequestCredential
  )
    throw new Error("GitHub host integration is not ready")
  const store = createKeyringStore("integration-github-credentials")
  const key = `setup:${input.operationId}`
  const raw = await store.load(key)
  if (!raw) throw new Error("GitHub setup credential reference is unavailable")
  const staging = stagingSchema.parse(JSON.parse(raw))
  if (staging.accountLabel.toLowerCase() !== input.expectedLogin.toLowerCase())
    throw new Error("GitHub setup account does not match the requested login")

  if (!staging.authSessionId) {
    if (!staging.token) throw new Error("GitHub setup credential is unavailable")
    const session = await getSession(providerId, ["repo"], {
      createIfNone: true,
      forceNewSession: true,
      configuration: { token: staging.token, accountLabel: staging.accountLabel },
    })
    if (!session) throw new Error("GitHub host authentication did not create a session")
    staging.authSessionId = session.id
    // Checkpoint before any account mutation; restart retries reuse this session.
    await store.save(key, JSON.stringify(staging))
  }
  const credential = await provider.resolveRequestCredential(staging.authSessionId, {
    accountId: staging.accountId ?? `setup:${input.operationId}`,
    origin: "https://api.github.com",
  })
  const response = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      accept: "application/vnd.github+json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error("GitHub credential verification failed")
  const identity = (await response.json()) as { login?: unknown }
  if (
    typeof identity.login !== "string" ||
    identity.login.toLowerCase() !== input.expectedLogin.toLowerCase()
  )
    throw new Error("GitHub credential belongs to another account")
  const accounts = await listIntegrationAccounts(pluginId, integrationId)
  let account = accounts.find((candidate) => candidate.authSessionId === staging.authSessionId)
  if (
    account &&
    (account.providerId !== providerId ||
      account.remoteAccountId?.toLowerCase() !== input.expectedLogin.toLowerCase())
  )
    throw new Error("GitHub setup account ownership changed")
  if (staging.accountId && account?.id !== staging.accountId)
    throw new Error("GitHub setup account was removed or replaced")
  if (!account) {
    account = await createIntegrationAccount(pluginId, {
      integrationId,
      providerId,
      authSessionId: staging.authSessionId,
      remoteAccountId: identity.login,
      label: identity.login,
    })
  }
  // Replace the staging token with a receipt; the PAT now belongs only to its auth provider.
  await store.save(
    key,
    JSON.stringify({
      accountLabel: staging.accountLabel,
      authSessionId: staging.authSessionId,
      accountId: account.id,
    })
  )
  const status = await checkIntegrationAccountHealth(pluginId, account.id)
  return { accountId: account.id, login: identity.login, health: status.health }
}

export async function connectGithubAccountFromSecret(raw: unknown): Promise<SetupResult> {
  if (!isHeadlessHost())
    throw new Error("GitHub credential setup requires the owning Headless host")
  const input = inputSchema.parse(raw)
  // Serialize setup operations across identities too: one host owns the account mutation.
  const previous = active.get("host")
  const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    connect(input)
  )
  active.set("host", result)
  try {
    return await result
  } catch {
    // Provider/network errors may include request data. Never relay them to callers or audit logs.
    throw new Error(
      "GitHub account setup failed; verify the encrypted credential, expected login, and host integration readiness"
    )
  } finally {
    if (active.get("host") === result) active.delete("host")
  }
}
