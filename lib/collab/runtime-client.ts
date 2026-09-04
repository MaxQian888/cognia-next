"use client"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { readActiveAccessToken } from "@/lib/logto/app-session"
import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { CollabClient, type CollabFetch } from "./client"
import { loadCollabConnection } from "./connection"

export interface CurrentCollabContext {
  localAccountId: string
  orgId: string
  userId: string
  client: CollabClient
}

export interface CurrentCollabContextDeps {
  localAccountId?: string
  registry?: Pick<UserBindingRegistry, "get">
  fetchImpl?: CollabFetch
  accessToken?: (localAccountId: string) => Promise<string | null>
  e2eContext?: CollabE2EContext
}

export interface CollabE2EContext {
  orgId: string
  userId: string
  baseUrl: string
  accessToken: string
}

declare global {
  interface Window {
    __cogniaCollabE2EContext?: CollabE2EContext
  }
}

export async function resolveCurrentCollabContext(
  deps: CurrentCollabContextDeps = {}
): Promise<CurrentCollabContext | null> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const e2eContext =
    deps.e2eContext ??
    (process.env.NEXT_PUBLIC_E2E === "1" && typeof window !== "undefined"
      ? window.__cogniaCollabE2EContext
      : undefined)
  if (e2eContext) {
    return {
      localAccountId,
      orgId: e2eContext.orgId,
      userId: e2eContext.userId,
      client: new CollabClient({
        baseUrl: e2eContext.baseUrl,
        accessToken: async () => e2eContext.accessToken,
        fetchImpl: deps.fetchImpl ?? createPlatformFetch(),
      }),
    }
  }
  const connection = loadCollabConnection(localAccountId)
  if (!connection) return null
  const binding = await (deps.registry ?? new UserBindingRegistry()).get(localAccountId)
  if (!binding?.orgId || !binding.userId) return null
  const token =
    deps.accessToken ?? ((localAccountId: string) => readActiveAccessToken(localAccountId))
  return {
    localAccountId,
    orgId: binding.orgId,
    userId: binding.userId,
    client: new CollabClient({
      baseUrl: connection.baseUrl,
      accessToken: () => token(localAccountId),
      fetchImpl: deps.fetchImpl ?? createPlatformFetch(),
    }),
  }
}
