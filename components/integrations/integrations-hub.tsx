"use client"

import { FormEvent, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ActivityIcon, PlugZapIcon, ShieldCheckIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  createIntegrationAccount,
  createIntegrationSubscription,
  listIntegrationActionJobs,
  listIntegrationAudit,
  updateIntegrationAccount,
} from "@/lib/db/integrations"
import { getDb } from "@/lib/db/schema"
import {
  approveIntegrationActionJob,
  cancelIntegrationActionJob,
} from "@/lib/integrations/action-runner"
import { listRegisteredIntegrationEntries } from "@/lib/integrations/registry"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import {
  deleteIntegrationSubscription,
  deleteIntegrationAccount,
  syncIntegrationIngressRoutes,
} from "@/lib/integrations/ingress-client"
import { getSession as getAuthSession } from "@/lib/plugin/auth/auth-provider-registry"

export function IntegrationsHub() {
  const t = useTranslations("integrations")
  const entries = listRegisteredIntegrationEntries()
  const snapshot = useLiveQuery(
    () =>
      Promise.all([
        getDb().integrationAccounts.toArray(),
        getDb().integrationSubscriptions.toArray(),
        listIntegrationActionJobs(),
        listIntegrationAudit(),
      ]),
    []
  )
  const [selectedKey, setSelectedKey] = useState("")
  const [label, setLabel] = useState("")
  const [authStrategyId, setAuthStrategyId] = useState("")
  const [remoteAccountId, setRemoteAccountId] = useState("")
  const [approvedOrigin, setApprovedOrigin] = useState("")
  const [subscriptionAccountId, setSubscriptionAccountId] = useState("")
  const [resourceKind, setResourceKind] = useState("")
  const [resourceId, setResourceId] = useState("")
  const [eventTypes, setEventTypes] = useState("")
  const [ingressSecret, setIngressSecret] = useState("")

  const [accounts = [], subscriptions = [], jobs = [], audit = []] = snapshot ?? []
  const selected = useMemo(
    () => entries.find((entry) => `${entry.pluginId}:${entry.definition.id}` === selectedKey),
    [entries, selectedKey]
  )

  async function addAccount(event: FormEvent) {
    event.preventDefault()
    const strategy = selected?.definition.authStrategies.find(
      (candidate) => candidate.id === authStrategyId
    )
    if (!selected || !strategy) return
    const session = await getAuthSession(strategy.providerId, strategy.scopes ?? [], {
      createIfNone: true,
      forceNewSession: true,
    })
    if (!session) return
    await createIntegrationAccount(selected.pluginId, {
      integrationId: selected.definition.id,
      providerId: strategy.providerId,
      authSessionId: session.id,
      remoteAccountId: remoteAccountId || session.account.id,
      approvedOrigins: approvedOrigin ? [approvedOrigin] : undefined,
      label: label || session.account.label,
    })
    setLabel("")
    setAuthStrategyId("")
    setRemoteAccountId("")
    setApprovedOrigin("")
  }

  async function addSubscription(event: FormEvent) {
    event.preventDefault()
    const account = accounts.find((candidate) => candidate.id === subscriptionAccountId)
    if (!account) return
    const normalizedEventTypes = eventTypes
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    if (normalizedEventTypes.length === 0) return
    const definition = entries.find(
      (entry) =>
        entry.pluginId === account.pluginId && entry.definition.id === account.integrationId
    )?.definition
    let ingressSecretHandle: string | undefined
    if (definition?.ingress) {
      if (!ingressSecret) return
      ingressSecretHandle = crypto.randomUUID()
      await createKeyringStore("integration-ingress").save(ingressSecretHandle, ingressSecret)
    }
    await createIntegrationSubscription(account.pluginId, {
      integrationId: account.integrationId,
      accountId: account.id,
      eventTypes: normalizedEventTypes,
      resourceKind: resourceKind || undefined,
      resourceId: resourceId || undefined,
      ingressSecretHandle,
    })
    await syncIntegrationIngressRoutes()
    setResourceKind("")
    setResourceId("")
    setEventTypes("")
    setIngressSecret("")
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <PlugZapIcon className="size-5" />
          <h1 className="text-xl font-semibold">{t("title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <section className="grid gap-3 md:grid-cols-3" aria-label={t("installed")}>
        {entries.map(({ pluginId, definition }) => (
          <Card key={`${pluginId}:${definition.id}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base" role="heading" aria-level={2}>
                {definition.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-muted-foreground">
              <p>{definition.description}</p>
              <div className="flex flex-wrap gap-1">
                {definition.authStrategies.map((strategy) => (
                  <Badge key={strategy.id} variant="outline">
                    {strategy.type}
                  </Badge>
                ))}
                {definition.actions.map((action) => (
                  <Badge key={action.id} variant={action.risk === "read" ? "outline" : "secondary"}>
                    {action.id} · {t(`risk.${action.risk}`)}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
        {entries.length === 0 && (
          <Card className="p-4 text-sm text-muted-foreground">{t("emptyPlugins")}</Card>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base" role="heading" aria-level={2}>
              {t("accounts.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form className="grid gap-3" onSubmit={addAccount}>
              <Label htmlFor="integration-definition">{t("accounts.integration")}</Label>
              <select
                id="integration-definition"
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={selectedKey}
                onChange={(event) => setSelectedKey(event.target.value)}
              >
                <option value="">{t("accounts.selectIntegration")}</option>
                {entries.map(({ pluginId, definition }) => (
                  <option
                    key={`${pluginId}:${definition.id}`}
                    value={`${pluginId}:${definition.id}`}
                  >
                    {definition.label}
                  </option>
                ))}
              </select>
              <Input
                aria-label={t("accounts.label")}
                placeholder={t("accounts.label")}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
              <select
                aria-label={t("accounts.authStrategy")}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={authStrategyId}
                onChange={(event) => setAuthStrategyId(event.target.value)}
              >
                <option value="">{t("accounts.selectAuthStrategy")}</option>
                {(selected?.definition.authStrategies ?? []).map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.label}
                  </option>
                ))}
              </select>
              <Input
                aria-label={t("accounts.remoteAccountId")}
                placeholder={t("accounts.remoteAccountId")}
                value={remoteAccountId}
                onChange={(event) => setRemoteAccountId(event.target.value)}
              />
              <Input
                type="url"
                aria-label={t("accounts.approvedOrigin")}
                placeholder={t("accounts.approvedOrigin")}
                value={approvedOrigin}
                onChange={(event) => setApprovedOrigin(event.target.value)}
              />
              <Button type="submit">{t("accounts.add")}</Button>
            </form>

            <div className="space-y-2">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{account.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {account.integrationId} · {t(`health.${account.health}`)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        updateIntegrationAccount(account.pluginId, account.id, {
                          enabled: !account.enabled,
                        })
                      }
                    >
                      {account.enabled ? t("disable") : t("enable")}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => deleteIntegrationAccount(account.pluginId, account.id)}
                    >
                      {t("remove")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base" role="heading" aria-level={2}>
              {t("subscriptions.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form className="grid gap-3" onSubmit={addSubscription}>
              <select
                aria-label={t("subscriptions.account")}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={subscriptionAccountId}
                onChange={(event) => setSubscriptionAccountId(event.target.value)}
              >
                <option value="">{t("subscriptions.selectAccount")}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </select>
              <Input
                aria-label={t("subscriptions.resourceKind")}
                placeholder={t("subscriptions.resourceKind")}
                value={resourceKind}
                onChange={(event) => setResourceKind(event.target.value)}
              />
              <Input
                aria-label={t("subscriptions.resourceId")}
                placeholder={t("subscriptions.resourceId")}
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
              />
              <Input
                aria-label={t("subscriptions.eventTypes")}
                placeholder={t("subscriptions.eventTypes")}
                value={eventTypes}
                onChange={(event) => setEventTypes(event.target.value)}
              />
              <Input
                type="password"
                aria-label={t("subscriptions.ingressSecret")}
                placeholder={t("subscriptions.ingressSecret")}
                value={ingressSecret}
                onChange={(event) => setIngressSecret(event.target.value)}
              />
              <Button type="submit">{t("subscriptions.add")}</Button>
            </form>
            {subscriptions.map((subscription) => (
              <div
                key={subscription.id}
                className="flex items-center justify-between rounded border p-3"
              >
                <div className="text-xs">
                  <p className="font-medium">{subscription.eventTypes.join(", ")}</p>
                  <p className="text-muted-foreground">
                    {[subscription.resourceKind, subscription.resourceId]
                      .filter(Boolean)
                      .join(" · ") || t("subscriptions.allResources")}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    deleteIntegrationSubscription(subscription.pluginId, subscription.id)
                  }
                >
                  {t("remove")}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base" role="heading" aria-level={2}>
            <ShieldCheckIcon className="size-4" />
            {t("approvals.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {jobs.map((job) => (
            <div key={job.id} className="flex items-center justify-between rounded border p-3">
              <div className="text-xs">
                <p className="font-medium">{job.actionId}</p>
                <p className="text-muted-foreground">
                  {t(`status.${job.status}`)} · {t(`risk.${job.risk}`)}
                </p>
              </div>
              <div className="flex gap-2">
                {job.status === "awaiting_approval" && (
                  <Button size="sm" onClick={() => approveIntegrationActionJob(job.id)}>
                    {t("approvals.approve")}
                  </Button>
                )}
                {!["succeeded", "failed", "deadlettered", "cancelled"].includes(job.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => cancelIntegrationActionJob(job.id)}
                  >
                    {t("approvals.cancel")}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {jobs.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("approvals.empty")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base" role="heading" aria-level={2}>
            <ActivityIcon className="size-4" />
            {t("audit.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {audit.slice(0, 100).map((entry) => (
            <div key={entry.id} className="grid grid-cols-[1fr_auto] gap-3 border-b py-2 text-xs">
              <span>{entry.kind}</span>
              <span className="text-muted-foreground">
                {entry.outcome} · {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
          {audit.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("audit.empty")}</p>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
