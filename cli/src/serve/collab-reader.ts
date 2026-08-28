/** Read-only collaboration-plane activation for the headless Brain. */

import { CollabClient, type CollabFetch } from "@/lib/collab/client"
import { saveCollabConnection } from "@/lib/collab/connection"
import {
  collabRefreshDelay,
  getCollabRefreshState,
  requestCollabRefresh,
} from "@/lib/collab/refresh-scheduler"
import { refreshCollabPlaneQuietly } from "@/lib/collab/refresh"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { refreshLogtoToken, type LogtoClientConfig, type LogtoSession } from "@/lib/logto/client"

import type { CollabCliConfig } from "../config/schema"
import {
  readLogtoSessionFile,
  writeLogtoSessionFile,
  type LogtoSessionFs,
} from "../config/logto-session"

const TOKEN_REFRESH_SKEW_MS = 60_000

export interface HeadlessCollabReaderDeps {
  sessionFs?: LogtoSessionFs
  fetchImpl?: CollabFetch
  refreshToken?: typeof refreshLogtoToken
  registry?: UserBindingRegistry
  now?: () => number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

function jwtSubject(token: string): string | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown
    }
    return typeof decoded.sub === "string" && decoded.sub ? decoded.sub : null
  } catch {
    return null
  }
}

async function freshSession(
  cliHome: string,
  deps: HeadlessCollabReaderDeps
): Promise<LogtoSession | null> {
  const session = readLogtoSessionFile(cliHome, deps.sessionFs)
  if (!session) return null
  const now = deps.now ?? Date.now
  if (
    session.expiresAt === undefined ||
    session.expiresAt - now() > TOKEN_REFRESH_SKEW_MS ||
    !session.refreshToken
  ) {
    return session
  }
  const config: LogtoClientConfig = {
    issuer: session.issuer,
    clientId: session.clientId,
    resource: session.resource,
    redirectUri: "",
    ...(session.organizationId ? { organizationId: session.organizationId } : {}),
  }
  const refreshed = await (deps.refreshToken ?? refreshLogtoToken)(
    config,
    session.refreshToken,
    deps.fetchImpl as typeof fetch | undefined
  )
  writeLogtoSessionFile(cliHome, refreshed, deps.sessionFs)
  return refreshed
}

export interface HeadlessCollabReader {
  status: "active" | "not-signed-in"
  stop(): void
}

/**
 * Bind the Brain profile to the server-owned identity, pull once, then poll.
 * It intentionally installs no outbound runner: Brain is a reader, never an
 * autonomous collaboration actor.
 */
export async function startHeadlessCollabReader(input: {
  accountId: string
  cliHome: string
  config: CollabCliConfig
  deps?: HeadlessCollabReaderDeps
}): Promise<HeadlessCollabReader> {
  const deps = input.deps ?? {}
  const initial = await freshSession(input.cliHome, deps)
  if (!initial) return { status: "not-signed-in", stop: () => undefined }

  const accessToken = async (): Promise<string | null> =>
    (await freshSession(input.cliHome, deps))?.accessToken ?? null
  const fetchImpl = deps.fetchImpl ?? fetch
  const client = new CollabClient({
    baseUrl: input.config.url,
    accessToken,
    fetchImpl,
    ...(deps.now ? { now: deps.now } : {}),
  })
  const identity = await client.identity(input.config.orgId)
  const subject = jwtSubject(initial.accessToken)
  if (!subject) throw new Error("collaboration Logto token has no readable subject")

  const registry = deps.registry ?? new UserBindingRegistry()
  await registry.bind({
    localAccountId: input.accountId,
    userId: identity.userId,
    orgId: identity.orgId,
    logtoSubject: subject,
    logtoIssuer: initial.issuer,
  })
  saveCollabConnection(input.accountId, { baseUrl: input.config.url })

  const refresh = (accountId: string) =>
    refreshCollabPlaneQuietly({
      localAccountId: accountId,
      registry,
      fetchImpl,
      accessToken: async () => accessToken(),
      ...(deps.now ? { now: deps.now } : {}),
    })
  await requestCollabRefresh(input.accountId, refresh, deps.now)

  const scheduleTimeout = deps.setTimeout ?? globalThis.setTimeout
  const cancelTimeout = deps.clearTimeout ?? globalThis.clearTimeout
  let stopped = false
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined
  const schedule = () => {
    if (stopped) return
    timer = scheduleTimeout(
      () => {
        void requestCollabRefresh(input.accountId, refresh, deps.now).finally(schedule)
      },
      collabRefreshDelay(getCollabRefreshState(input.accountId).failures)
    )
    ;(timer as NodeJS.Timeout).unref?.()
  }
  schedule()
  return {
    status: "active",
    stop: () => {
      stopped = true
      if (timer !== undefined) cancelTimeout(timer)
    },
  }
}
