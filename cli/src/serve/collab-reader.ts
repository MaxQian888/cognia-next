/** Read-only collaboration-plane activation for the headless Brain. */

import path from "node:path"

import { CollabClient, type CollabFetch } from "@/lib/collab/client"
import { saveCollabConnection } from "@/lib/collab/connection"
import { requestCollabRefresh } from "@/lib/collab/refresh-scheduler"
import { ALL_COLLAB_REFRESH_LEGS, refreshCollabPlaneQuietly } from "@/lib/collab/refresh"
import type { HeadlessCollabAdapter } from "@/lib/headless/runtimes/collab-runtime"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { refreshLogtoToken, type LogtoSession } from "@/lib/logto/client"

import type { CollabCliConfig } from "../config/schema"
import { freshLogtoSessionFile, type LogtoSessionFs } from "../config/logto-session"
import { realSessionStoreFs, type SessionStoreFs } from "../agent/session-store/paths"

export interface HeadlessCollabReaderDeps {
  sessionFs?: LogtoSessionFs
  fetchImpl?: CollabFetch
  refreshToken?: typeof refreshLogtoToken
  registry?: UserBindingRegistry
  now?: () => number
  cursorFs?: Pick<SessionStoreFs, "readFile" | "writeFileAtomic">
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

function freshSession(
  cliHome: string,
  deps: HeadlessCollabReaderDeps
): Promise<LogtoSession | null> {
  return freshLogtoSessionFile(cliHome, {
    sessionFs: deps.sessionFs,
    fetchImpl: deps.fetchImpl as typeof fetch | undefined,
    refreshToken: deps.refreshToken,
    now: deps.now,
  })
}

export interface HeadlessCollabReader {
  status: "active" | "not-signed-in"
  runtime?: HeadlessCollabAdapter
  stop(): void
}

/** Synchronous cursor updates, persisted atomically outside ephemeral Web Storage. */
export function createCollabCursorStorage(
  cliHome: string,
  localAccountId: string,
  fsImpl: NonNullable<HeadlessCollabReaderDeps["cursorFs"]> = realSessionStoreFs
): HeadlessCollabAdapter["local"] {
  const file = path.join(
    cliHome,
    "collab-notifications",
    `${encodeURIComponent(localAccountId)}.json`
  )
  const read = (): Record<string, string> => {
    const raw = fsImpl.readFile(file)
    if (!raw) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== "string")
    ) {
      return {}
    }
    return parsed as Record<string, string>
  }
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) =>
      fsImpl.writeFileAtomic(file, JSON.stringify({ ...read(), [key]: value })),
    removeItem: (key) => {
      const current = read()
      delete current[key]
      fsImpl.writeFileAtomic(file, JSON.stringify(current))
    },
  }
}

/**
 * Bind the Brain profile to the server-owned identity and pull once. The
 * registered collab runtimes own subsequent feed, notification and poll work.
 * It intentionally installs no outbound runner: Brain is a reader, never an
 * autonomous collaboration actor.
 */
export async function startHeadlessCollabReader(input: {
  localAccountId: string
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
    localAccountId: input.localAccountId,
    userId: identity.userId,
    orgId: identity.orgId,
    logtoSubject: subject,
    logtoIssuer: initial.issuer,
  })
  saveCollabConnection(input.localAccountId, { baseUrl: input.config.url })

  const refresh: HeadlessCollabAdapter["refresh"] = (localAccountId, legs) =>
    refreshCollabPlaneQuietly({
      localAccountId: localAccountId,
      registry,
      fetchImpl,
      accessToken: async () => accessToken(),
      legs,
      ...(deps.now ? { now: deps.now } : {}),
    })
  const refreshAll = () => refresh(input.localAccountId, ALL_COLLAB_REFRESH_LEGS)
  await requestCollabRefresh(input.localAccountId, refreshAll, deps.now)
  return {
    status: "active",
    runtime: {
      resolve: async (localAccountId) =>
        localAccountId === input.localAccountId && (await freshSession(input.cliHome, deps))
          ? { client, orgId: input.config.orgId }
          : null,
      refresh,
      refreshAll,
      local: createCollabCursorStorage(input.cliHome, input.localAccountId, deps.cursorFs),
    },
    stop: () => undefined,
  }
}
