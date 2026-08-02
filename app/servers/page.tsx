"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { ServerOperationsCenter } from "@/components/servers/server-operations-center"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import {
  OpsClient,
  OpsError,
  loadCachedServerList,
  saveCachedServerList,
  type Operation,
  type RecoveryPoint,
  type ServerDetail,
  type ServerLogEntry,
  type ServerSummary,
} from "@/lib/server-ops/client"
import { parseDeploymentTarget, type DeploymentTarget } from "@/lib/server-ops/deployment-target"
import { useAccountStore } from "@/stores/account/account-store"

interface ControllerConnection {
  controllerUrl: string
  targetId: string
}

const tokenStore = createKeyringStore("server-ops-oidc")
const CONNECTION_PREFIX = "cognia.server-ops.connection.v1"

export default function ServersPage() {
  const t = useTranslations("servers")
  const accountId = useAccountStore((state) => state.unlockedAccountId)
  const [connection, setConnection] = useState<ControllerConnection | null>(null)
  const [controllerUrl, setControllerUrl] = useState("")
  const [targetId, setTargetId] = useState("default")
  const [accessToken, setAccessToken] = useState("")
  const [connected, setConnected] = useState(false)
  const [servers, setServers] = useState<ServerDetail[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [backups, setBackups] = useState<RecoveryPoint[]>([])
  const [logs, setLogs] = useState<ServerLogEntry[]>([])
  const [operations, setOperations] = useState<Operation[]>([])
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if (!accountId) return
    try {
      const raw = localStorage.getItem(`${CONNECTION_PREFIX}.${encodeURIComponent(accountId)}`)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<ControllerConnection>
      if (typeof parsed.controllerUrl !== "string" || typeof parsed.targetId !== "string") return
      const next = { controllerUrl: parsed.controllerUrl, targetId: parsed.targetId }
      // Hydrate the account-scoped external connection record after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnection(next)
      setControllerUrl(next.controllerUrl)
      setTargetId(next.targetId)
      void tokenStore
        .load(tokenKey(accountId, next.targetId))
        .then((token) => setConnected(Boolean(token)))
    } catch {
      localStorage.removeItem(`${CONNECTION_PREFIX}.${encodeURIComponent(accountId)}`)
    }
  }, [accountId])

  const client = useMemo(() => {
    if (!connection || !accountId || !connected) return null
    return new OpsClient({
      baseUrl: connection.controllerUrl,
      accessToken: async () =>
        (await tokenStore.load(tokenKey(accountId, connection.targetId))) ?? "",
    })
  }, [accountId, connected, connection])

  const refresh = useCallback(async () => {
    if (!client || !accountId || !connection) return
    setLoading(true)
    try {
      const summaries = await client.listServers()
      const details = await Promise.all(summaries.map((summary) => client.getServer(summary.id)))
      setServers(details)
      saveCachedServerList(localStorage, accountId, connection.targetId, summaries)
      setSelectedId((current) => current ?? details[0]?.id ?? null)
      setOffline(false)
    } catch (error) {
      const cached = loadCachedServerList(localStorage, accountId, connection.targetId)
      setServers(cached.map(cachedDetail))
      setSelectedId((current) => current ?? cached[0]?.id ?? null)
      setOffline(true)
      toast.error(t("errors.refresh"), { description: localizedError(t, error) })
    } finally {
      setLoading(false)
    }
  }, [accountId, client, connection, t])

  useEffect(() => {
    // The Controller client is an external resource; refresh once it becomes available.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (client) void refresh()
  }, [client, refresh])

  useEffect(() => {
    if (!client || !selectedId || offline) {
      // Clear remote-only detail when switching to the isolated offline view.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBackups([])
      setLogs([])
      return
    }
    let cancelled = false
    void Promise.all([client.listBackups(selectedId), client.listLogs(selectedId)]).then(
      ([nextBackups, nextLogs]) => {
        if (cancelled) return
        setBackups(nextBackups)
        setLogs(nextLogs)
      },
      (error) =>
        !cancelled && toast.error(t("errors.detail"), { description: localizedError(t, error) })
    )
    return () => {
      cancelled = true
    }
  }, [client, offline, selectedId, t])

  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!accountId) return
    setLoading(true)
    try {
      const candidate = new OpsClient({
        baseUrl: controllerUrl,
        accessToken: () => Promise.resolve(accessToken),
      })
      await candidate.capabilities()
      const next = { controllerUrl, targetId }
      await tokenStore.save(tokenKey(accountId, targetId), accessToken)
      localStorage.setItem(
        `${CONNECTION_PREFIX}.${encodeURIComponent(accountId)}`,
        JSON.stringify(next)
      )
      setConnection(next)
      setConnected(true)
      setAccessToken("")
      toast.success(t("connection.connected"))
    } catch (error) {
      toast.error(t("connection.failed"), { description: localizedError(t, error) })
    } finally {
      setLoading(false)
    }
  }

  const recordOperation = (operation: Operation) => {
    setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)])
  }
  const run = async (action: () => Promise<Operation>) => {
    try {
      const operation = await action()
      recordOperation(operation)
      toast.success(t("operations.queued"))
    } catch (error) {
      toast.error(t("errors.operation"), { description: localizedError(t, error) })
    }
  }
  const withAdminLease = async (
    serverId: string,
    kind: "restore" | "rollback" | "rotate-key",
    action: (lease: string, idempotencyKey: string) => Promise<Operation>
  ) => {
    if (!client) return
    const lease = await client.createAdminLease(serverId, kind, crypto.randomUUID())
    await run(() => action(lease.token, crypto.randomUUID()))
  }

  if (!accountId) {
    return (
      <div className="grid h-full w-full place-items-center p-6 text-sm text-muted-foreground">
        {t("connection.unlockAccount")}
      </div>
    )
  }

  if (!client) {
    return (
      <div className="grid h-full w-full place-items-center overflow-y-auto p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>{t("connection.title")}</CardTitle>
            <CardDescription>{t("connection.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={connect} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ops-controller-url">{t("connection.controllerUrl")}</Label>
                <Input
                  id="ops-controller-url"
                  type="url"
                  required
                  value={controllerUrl}
                  onChange={(event) => setControllerUrl(event.target.value)}
                  placeholder={t("connection.controllerPlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ops-target-id">{t("connection.targetId")}</Label>
                <Input
                  id="ops-target-id"
                  required
                  value={targetId}
                  onChange={(event) => setTargetId(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ops-access-token">{t("connection.accessToken")}</Label>
                <Input
                  id="ops-access-token"
                  type="password"
                  required
                  autoComplete="off"
                  value={accessToken}
                  onChange={(event) => setAccessToken(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("connection.tokenNotice")}</p>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t("connection.connecting") : t("connection.connect")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  const selectedServer = servers.find((server) => server.id === selectedId) ?? null
  return (
    <ServerOperationsCenter
      servers={servers}
      selectedServer={selectedServer}
      backups={backups}
      logs={logs}
      operations={operations}
      offline={offline}
      loading={loading}
      onSelectServer={setSelectedId}
      onRefresh={() => void refresh()}
      onBackup={(id) => void run(() => client.createBackup(id, crypto.randomUUID()))}
      onRestore={(id, recoveryPointId) =>
        void withAdminLease(id, "restore", (lease, key) =>
          client.restore(id, recoveryPointId, lease, key)
        )
      }
      onRollback={(id) =>
        void withAdminLease(id, "rollback", (lease, key) => client.rollback(id, lease, key))
      }
      onRotateKey={(id, keyVersion) =>
        void withAdminLease(id, "rotate-key", (lease, key) =>
          client.rotateKey(id, keyVersion, lease, key)
        )
      }
      onValidateTarget={async (target: DeploymentTarget) => {
        const parsed = parseDeploymentTarget(target)
        await client.validateTarget(parsed, crypto.randomUUID())
        const registered = await client.registerTarget(parsed, crypto.randomUUID())
        const operation = await client.deploy(
          registered.id,
          {
            targetRevision: registered.targetRevision,
            release: {
              serverImage: parsed.spec.images.server,
              runnerImage: parsed.spec.images.runner,
              workspaceRuntimeImage: parsed.spec.images.workspaceRuntime,
              configRevision: String(registered.targetRevision),
            },
          },
          crypto.randomUUID()
        )
        recordOperation(operation)
        await refresh()
        toast.success(t("wizard.valid"))
      }}
    />
  )
}

function tokenKey(accountId: string, targetId: string): string {
  return `${accountId}:${targetId}:access-token`
}

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

function localizedError(t: ReturnType<typeof useTranslations<"servers">>, error: unknown): string {
  if (error instanceof OpsError) {
    if (error.code === "authentication_required" || error.code === "unauthorized") {
      return t("errors.authenticationRequired")
    }
    if (error.code === "network_unavailable") return t("errors.networkUnavailable")
  }
  return t("errors.recovery")
}
