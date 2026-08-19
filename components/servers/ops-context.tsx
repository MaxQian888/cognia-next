"use client"

/**
 * Shared Ops Controller session for every `/servers` route (ADR-0059).
 *
 * Mounted once in `app/servers/layout.tsx` so the fleet list and the detail
 * route share one client, one event subscription, and — critically — one
 * operation history. The controller exposes no "list operations" endpoint:
 * an operation is only ever learned from the response that queued it or from
 * the live event stream, so an operation discovered on the list route would be
 * lost the moment the user opened a server if each route held its own state.
 *
 * The transport is platform-routed (`lib/server-ops/transport`) because the
 * controller host is user-supplied: the desktop WebView's CSP blocks it, and a
 * self-hosted controller sends no CORS headers to a browser. Where no shell-side
 * transport can hold the SSE stream open, this falls back to polling the
 * operations it already knows about.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { createKeyringStore } from "@/lib/credentials/keyring-store"
import {
  OpsClient,
  OpsError,
  loadCachedServerList,
  saveCachedServerList,
  type EnrollmentToken,
  type Operation,
  type ProviderCapabilities,
  type ServerDetail,
  type ServerSummary,
} from "@/lib/server-ops/client"
import {
  followOperationStream,
  isTerminalOperation,
  pollOperationUpdates,
} from "@/lib/server-ops/operation-stream"
import type { DeploymentTarget } from "@/lib/server-ops/deployment-target"
import {
  createOpsEventStream,
  createOpsFetch,
  opsTransportKind,
  supportsLiveOperationEvents,
  type OpsTransportKind,
} from "@/lib/server-ops/transport"
import { useAccountStore } from "@/stores/account/account-store"

export interface ControllerConnection {
  controllerUrl: string
  /**
   * Local profile name. It scopes the keyring entry and the offline cache and
   * is never sent to the controller — tenancy comes from the OIDC token.
   */
  profileId: string
}

export interface ConnectInput extends ControllerConnection {
  accessToken: string
}

/** Protected operations the controller gates behind a short-lived admin lease. */
export type AdminOperationKind = "restore" | "rollback" | "rotate-key"

export interface ServerOpsValue {
  accountId: string | null
  connection: ControllerConnection | null
  connected: boolean
  transport: OpsTransportKind
  /** False where the shell can only poll; the UI says so rather than lying. */
  liveEvents: boolean
  eventStreamConnected: boolean
  servers: ServerDetail[]
  capabilities: ProviderCapabilities | null
  operations: Operation[]
  loading: boolean
  connecting: boolean
  /** The fleet on screen came from the offline cache, not the controller. */
  offline: boolean
  connect: (input: ConnectInput) => Promise<boolean>
  disconnect: () => Promise<void>
  refresh: () => Promise<void>
  serverById: (id: string) => ServerDetail | null
  backup: (id: string) => Promise<void>
  preflight: (id: string) => Promise<void>
  collectStatus: (id: string, includeRuntimeUsage: boolean) => Promise<void>
  collectLogs: (id: string) => Promise<void>
  restore: (id: string, recoveryPointId: string) => Promise<void>
  rollback: (id: string) => Promise<void>
  rotateKey: (id: string, keyVersion: string) => Promise<void>
  upgrade: (
    id: string,
    release: {
      serverImage: string
      runnerImage: string
      workspaceRuntimeImage: string
    }
  ) => Promise<void>
  cancelOperation: (operationId: string) => Promise<void>
  registerAndDeploy: (target: DeploymentTarget) => Promise<void>
  createEnrollmentToken: (targetId: string) => Promise<EnrollmentToken | null>
  listBackups: OpsClient["listBackups"] | null
  listLogs: OpsClient["listLogs"] | null
}

const ServerOpsContext = createContext<ServerOpsValue | null>(null)

const tokenStore = createKeyringStore("server-ops-oidc")
const CONNECTION_PREFIX = "cognia.server-ops.connection.v1"

function connectionKey(accountId: string): string {
  return `${CONNECTION_PREFIX}.${encodeURIComponent(accountId)}`
}

function tokenKey(accountId: string, profileId: string): string {
  return `${accountId}:${profileId}:access-token`
}

/**
 * A cached summary rendered as a detail.
 *
 * Everything the cache cannot know is reported as absent rather than as a
 * default: an uncertified badge on a server nobody has asked about would be a
 * claim, and `targetRevision: 0` is not a revision that exists.
 */
function cachedDetail(summary: ServerSummary): ServerDetail {
  return {
    ...summary,
    targetRevision: 0,
    productionCertified: false,
    certificationIssues: [],
    capabilities: {
      topologies: [],
      snapshotProviders: [],
      secretProviders: [],
      tlsProviders: [],
      objectStoreProtocols: [],
      requiresProviderCredentials: false,
    },
  }
}

/** Map a controller failure onto an actionable sentence. */
export function localizedOpsError(
  t: ReturnType<typeof useTranslations<"servers">>,
  error: unknown
): string {
  if (error instanceof OpsError) {
    if (error.code === "authentication_required" || error.code === "unauthorized") {
      return t("errors.authenticationRequired")
    }
    if (error.code === "network_unavailable") {
      return opsTransportKind() === "browser"
        ? t("errors.networkUnavailableBrowser")
        : t("errors.networkUnavailable")
    }
    if (error.code === "operation_not_cancellable") return t("errors.notCancellable")
    if (error.code === "insufficient_scope") return t("errors.insufficientScope")
    if (error.code === "target_busy") return t("errors.targetBusy")
  }
  return t("errors.recovery")
}

export function ServerOpsProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("servers")
  const accountId = useAccountStore((state) => state.unlockedAccountId)
  const [connection, setConnection] = useState<ControllerConnection | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [servers, setServers] = useState<ServerDetail[]>([])
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [eventStreamConnected, setEventStreamConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)

  const transport = useMemo(() => opsTransportKind(), [])
  const liveEvents = useMemo(() => supportsLiveOperationEvents(), [])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    const raw = localStorage.getItem(connectionKey(accountId))
    if (!raw) return
    let parsed: Partial<ControllerConnection>
    try {
      parsed = JSON.parse(raw) as Partial<ControllerConnection>
    } catch {
      localStorage.removeItem(connectionKey(accountId))
      return
    }
    if (typeof parsed.controllerUrl !== "string" || typeof parsed.profileId !== "string") {
      localStorage.removeItem(connectionKey(accountId))
      return
    }
    const next = { controllerUrl: parsed.controllerUrl, profileId: parsed.profileId }
    void tokenStore.load(tokenKey(accountId, next.profileId)).then((token) => {
      if (cancelled) return
      // Only surface a connection whose token actually survived: a stored URL
      // with a purged keyring entry would render a connected shell that fails
      // on its first request.
      setConnection(next)
      setConnected(Boolean(token))
    })
    return () => {
      cancelled = true
    }
  }, [accountId])

  const client = useMemo(() => {
    if (!connection || !accountId || !connected) return null
    const accessToken = async () =>
      (await tokenStore.load(tokenKey(accountId, connection.profileId))) ?? ""
    try {
      return new OpsClient({
        baseUrl: connection.controllerUrl,
        accessToken,
        fetchImpl: createOpsFetch(),
        eventStream:
          createOpsEventStream({ controllerUrl: connection.controllerUrl, accessToken }) ??
          undefined,
      })
    } catch {
      // `normalizeControllerUrl` throws on a stored URL that no longer passes
      // the HTTPS rule (an app upgrade tightening it, a hand-edited entry).
      return null
    }
  }, [accountId, connected, connection])

  const refresh = useCallback(async () => {
    if (!client || !accountId || !connection) return
    setLoading(true)
    try {
      const summaries = await client.listServers()
      // One request per server, in parallel: the controller has no bulk detail
      // endpoint, and serially this grew linearly with fleet size.
      const details = await Promise.all(summaries.map((summary) => client.getServer(summary.id)))
      setServers(details)
      saveCachedServerList(localStorage, accountId, connection.profileId, summaries)
      setOffline(false)
    } catch (error) {
      const cached = loadCachedServerList(localStorage, accountId, connection.profileId)
      setServers(cached.map(cachedDetail))
      setOffline(true)
      toast.error(t("errors.refresh"), { description: localizedOpsError(t, error) })
    } finally {
      setLoading(false)
    }
  }, [accountId, client, connection, t])

  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    // Deferred a microtask: `refresh` sets state, and a synchronous setState in
    // an effect body cascades renders.
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) void refresh()
    })
    return () => controller.abort()
  }, [client, refresh])

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void client.capabilities().then(
      (next) => !cancelled && setCapabilities(next),
      (error) =>
        !cancelled &&
        toast.error(t("errors.capabilities"), { description: localizedOpsError(t, error) })
    )
    return () => {
      cancelled = true
    }
  }, [client, t])

  const recordOperation = useCallback((operation: Operation) => {
    setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)])
  }, [])

  // Read by the polling fallback, which must see the operation list as it is on
  // each tick without re-subscribing every time an operation changes.
  const operationsRef = useRef(operations)
  useEffect(() => {
    operationsRef.current = operations
  }, [operations])

  useEffect(() => {
    if (!client) return
    const controller = new AbortController()

    if (!liveEvents) {
      void pollOperationUpdates(client, {
        signal: controller.signal,
        pending: () =>
          operationsRef.current.filter((item) => !isTerminalOperation(item)).map((item) => item.id),
        onOperation: (operation) => {
          recordOperation(operation)
          if (isTerminalOperation(operation)) void refresh()
        },
      })
      return () => controller.abort()
    }

    // Optimistic: the stream is assumed up until it reports otherwise, so the
    // badge does not flash "reconnecting" before the first event arrives.
    // Deferred to a microtask because a synchronous setState in an effect body
    // is a lint error in this repo, not because the timing matters.
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) setEventStreamConnected(true)
    })
    void followOperationStream(client, {
      signal: controller.signal,
      onOperation: (operation) => {
        setEventStreamConnected(true)
        recordOperation(operation)
        // A finished operation is the only thing that can have changed the
        // fleet's health, release digest, or recovery points.
        if (isTerminalOperation(operation)) void refresh()
      },
      onError: () => setEventStreamConnected(false),
    })
    return () => controller.abort()
  }, [client, liveEvents, recordOperation, refresh])

  const connect = useCallback(
    async (input: ConnectInput) => {
      if (!accountId) return false
      setConnecting(true)
      try {
        const candidate = new OpsClient({
          baseUrl: input.controllerUrl,
          accessToken: () => Promise.resolve(input.accessToken),
          fetchImpl: createOpsFetch(),
        })
        // Proves the URL, the token, and the read scope in one round trip
        // before anything is persisted.
        const nextCapabilities = await candidate.capabilities()
        const next = { controllerUrl: input.controllerUrl, profileId: input.profileId }
        await tokenStore.save(tokenKey(accountId, input.profileId), input.accessToken)
        localStorage.setItem(connectionKey(accountId), JSON.stringify(next))
        setConnection(next)
        setCapabilities(nextCapabilities)
        setConnected(true)
        toast.success(t("connection.connected"))
        return true
      } catch (error) {
        toast.error(t("connection.failed"), { description: localizedOpsError(t, error) })
        return false
      } finally {
        setConnecting(false)
      }
    },
    [accountId, t]
  )

  const disconnect = useCallback(async () => {
    if (!accountId || !connection) return
    try {
      await tokenStore.delete(tokenKey(accountId, connection.profileId))
    } catch (error) {
      toast.error(t("connection.disconnectFailed"), { description: localizedOpsError(t, error) })
      return
    }
    localStorage.removeItem(connectionKey(accountId))
    setConnection(null)
    setConnected(false)
    setCapabilities(null)
    setEventStreamConnected(false)
    setServers([])
    setOperations([])
    setOffline(false)
    toast.success(t("connection.disconnected"))
  }, [accountId, connection, t])

  /** Queue one operation, recording it and reporting the outcome once. */
  const run = useCallback(
    async (action: () => Promise<Operation>) => {
      try {
        recordOperation(await action())
        toast.success(t("operations.queued"))
      } catch (error) {
        toast.error(t("errors.operation"), { description: localizedOpsError(t, error) })
      }
    },
    [recordOperation, t]
  )

  /**
   * Take a short-lived, user- and operation-bound admin lease, then spend it.
   *
   * The lease is requested at the moment of use rather than held: the
   * controller consumes it on the mutation, so one lease can never authorize a
   * second protected operation.
   */
  const withAdminLease = useCallback(
    async (
      serverId: string,
      kind: AdminOperationKind,
      action: (lease: string, idempotencyKey: string) => Promise<Operation>
    ) => {
      if (!client) return
      await run(async () => {
        const lease = await client.createAdminLease(serverId, kind, crypto.randomUUID())
        return action(lease.token, crypto.randomUUID())
      })
    },
    [client, run]
  )

  const value = useMemo<ServerOpsValue>(() => {
    const requireClient = <A extends unknown[]>(
      action: (client: OpsClient, ...args: A) => Promise<void>
    ) => {
      return async (...args: A) => {
        if (!client) return
        await action(client, ...args)
      }
    }
    return {
      accountId,
      connection,
      connected: Boolean(client),
      transport,
      liveEvents,
      eventStreamConnected,
      servers,
      capabilities,
      operations,
      loading,
      connecting,
      offline,
      connect,
      disconnect,
      refresh,
      serverById: (id) => servers.find((server) => server.id === id) ?? null,
      backup: requireClient((ops, id: string) =>
        run(() => ops.createBackup(id, crypto.randomUUID()))
      ),
      preflight: requireClient((ops, id: string) =>
        run(() => ops.preflight(id, crypto.randomUUID()))
      ),
      collectStatus: requireClient((ops, id: string, includeRuntimeUsage: boolean) =>
        run(() => ops.collectStatus(id, crypto.randomUUID(), { includeRuntimeUsage }))
      ),
      collectLogs: requireClient((ops, id: string) =>
        run(() => ops.collectLogs(id, crypto.randomUUID()))
      ),
      restore: async (id, recoveryPointId) =>
        withAdminLease(id, "restore", (lease, key) => {
          if (!client) throw new Error("disconnected")
          return client.restore(id, recoveryPointId, lease, key)
        }),
      rollback: async (id) =>
        withAdminLease(id, "rollback", (lease, key) => {
          if (!client) throw new Error("disconnected")
          return client.rollback(id, lease, key)
        }),
      rotateKey: async (id, keyVersion) =>
        withAdminLease(id, "rotate-key", (lease, key) => {
          if (!client) throw new Error("disconnected")
          return client.rotateKey(id, keyVersion, lease, key)
        }),
      upgrade: requireClient(async (ops, id: string, release) => {
        const server = servers.find((candidate) => candidate.id === id)
        if (!server) return
        await run(() =>
          ops.upgrade(
            id,
            {
              targetRevision: server.targetRevision,
              release: { ...release, configRevision: String(server.targetRevision) },
            },
            crypto.randomUUID()
          )
        )
      }),
      cancelOperation: requireClient(async (ops, operationId: string) => {
        try {
          recordOperation(await ops.cancelOperation(operationId, crypto.randomUUID()))
          toast.success(t("operations.cancelled"))
        } catch (error) {
          toast.error(t("errors.cancel"), { description: localizedOpsError(t, error) })
        }
      }),
      registerAndDeploy: async (target: DeploymentTarget) => {
        if (!client) return
        // Validate, register, then deploy the revision the controller just
        // assigned. Deploying a client-guessed revision is how a stale tab
        // ships against a configuration that has since moved, and the agent
        // rejects the mismatch rather than guessing which one was meant.
        await client.validateTarget(target, crypto.randomUUID())
        const registered = await client.registerTarget(target, crypto.randomUUID())
        const operation = await client.deploy(
          registered.id,
          {
            targetRevision: registered.targetRevision,
            release: {
              serverImage: target.spec.images.server,
              runnerImage: target.spec.images.runner,
              workspaceRuntimeImage: target.spec.images.workspaceRuntime,
              configRevision: String(registered.targetRevision),
            },
          },
          crypto.randomUUID()
        )
        recordOperation(operation)
        await refresh()
      },
      createEnrollmentToken: async (targetId: string) => {
        if (!client) return null
        try {
          return await client.createEnrollmentToken(targetId, crypto.randomUUID())
        } catch (error) {
          toast.error(t("enroll.failed"), { description: localizedOpsError(t, error) })
          return null
        }
      },
      listBackups: client ? client.listBackups.bind(client) : null,
      listLogs: client ? client.listLogs.bind(client) : null,
    }
  }, [
    accountId,
    capabilities,
    client,
    connect,
    connecting,
    connection,
    disconnect,
    eventStreamConnected,
    liveEvents,
    loading,
    offline,
    operations,
    recordOperation,
    refresh,
    run,
    servers,
    t,
    transport,
    withAdminLease,
  ])

  return <ServerOpsContext.Provider value={value}>{children}</ServerOpsContext.Provider>
}

export function useServerOps(): ServerOpsValue {
  const value = useContext(ServerOpsContext)
  if (!value) throw new Error("useServerOps must be used inside <ServerOpsProvider>")
  return value
}
