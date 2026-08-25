"use client"

import { FormEvent, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ActivityIcon, PlugZapIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  createIntegrationAccount,
  createIntegrationSubscription,
  getIntegrationAccount,
  listIntegrationActionJobs,
  listIntegrationAudit,
  updateIntegrationAccount,
} from "@/lib/db/integrations"
import { getDb } from "@/lib/db/schema"
import {
  approveIntegrationActionJob,
  cancelIntegrationActionJob,
} from "@/lib/integrations/action-runner"
import {
  checkIntegrationAccountHealth,
  listIntegrationResources,
} from "@/lib/integrations/providers"
import {
  getIntegrationRegistryRevision,
  listRegisteredIntegrationEntries,
  subscribeIntegrationRegistry,
} from "@/lib/integrations/registry"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import {
  deleteIntegrationSubscription,
  deleteIntegrationAccount,
  getIntegrationIngressPublicUrl,
  listIntegrationIngressDeadletters,
  requeueIntegrationIngressDeadletter,
  syncIntegrationIngressRoutes,
} from "@/lib/integrations/ingress-client"
import { getSession as getAuthSession } from "@/lib/plugin/auth/auth-provider-registry"
import {
  discoverGithubAppInstallations,
  type GithubAppInstallationOption,
} from "@/lib/integrations/github-auth"
import { detectPlatform } from "@/lib/platform/detect"
import { rotateGithubWebhookSecret } from "@/lib/integrations/github-webhook"
import type {
  IntegrationIngressDeadLetter,
  IntegrationResourceRef,
} from "@/types/plugin/plugin-integration"

const CONFIG_FIELD_TRANSLATIONS = {
  accountLabel: "accounts.configFields.accountLabel",
  appId: "accounts.configFields.appId",
  privateKey: "accounts.configFields.privateKey",
  token: "accounts.configFields.token",
} as const

const GITHUB_STATUS_TRANSLATIONS = {
  installation_revoked: "accounts.statusMessages.installationRevoked",
  installation_suspended: "accounts.statusMessages.installationSuspended",
  permissions_missing: "accounts.statusMessages.permissionsMissing",
  remote_reconciliation_unavailable: "accounts.statusMessages.remoteReconciliationUnavailable",
  webhook_verified: "accounts.statusMessages.webhookVerified",
} as const

const GITHUB_EVENT_TRANSLATIONS = {
  "check_run.completed": "subscriptions.eventLabels.checkRunCompleted",
  "github_app_authorization.revoked": "subscriptions.eventLabels.githubAppAuthorizationRevoked",
  "installation.created": "subscriptions.eventLabels.installationCreated",
  "installation.deleted": "subscriptions.eventLabels.installationDeleted",
  "installation.new_permissions_accepted":
    "subscriptions.eventLabels.installationPermissionsAccepted",
  "installation.suspend": "subscriptions.eventLabels.installationSuspended",
  "installation.unsuspend": "subscriptions.eventLabels.installationUnsuspended",
  "installation_repositories.added": "subscriptions.eventLabels.repositoriesAdded",
  "installation_repositories.removed": "subscriptions.eventLabels.repositoriesRemoved",
  "issue_comment.created": "subscriptions.eventLabels.issueCommentCreated",
  "issues.assigned": "subscriptions.eventLabels.issueAssigned",
  "issues.closed": "subscriptions.eventLabels.issueClosed",
  "issues.labeled": "subscriptions.eventLabels.issueLabeled",
  "issues.opened": "subscriptions.eventLabels.issueOpened",
  "pull_request.closed": "subscriptions.eventLabels.pullRequestClosed",
  "pull_request.opened": "subscriptions.eventLabels.pullRequestOpened",
  "pull_request.review_requested": "subscriptions.eventLabels.pullRequestReviewRequested",
  "pull_request.synchronize": "subscriptions.eventLabels.pullRequestSynchronized",
  "pull_request_review.submitted": "subscriptions.eventLabels.pullRequestReviewSubmitted",
  "push.received": "subscriptions.eventLabels.pushReceived",
  "release.published": "subscriptions.eventLabels.releasePublished",
} as const

const GITHUB_PROJECTION_TRANSLATIONS = {
  "issue-comment-thread": "subscriptions.projectionLabels.issueCommentThread",
  "issue-thread": "subscriptions.projectionLabels.issueThread",
  "pull-request-thread": "subscriptions.projectionLabels.pullRequestThread",
} as const

function configuredValue(value: string, schema: Record<string, unknown>): unknown {
  return schema.type === "integer" ? Number(value) : value
}

export function IntegrationsHub() {
  const t = useTranslations("integrations")
  const registryRevision = useSyncExternalStore(
    subscribeIntegrationRegistry,
    getIntegrationRegistryRevision,
    () => 0
  )
  const entries = useMemo(() => {
    void registryRevision
    return listRegisteredIntegrationEntries()
  }, [registryRevision])
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
  const [authConfiguration, setAuthConfiguration] = useState<Record<string, string>>({})
  const [dedicatedAppConfirmed, setDedicatedAppConfirmed] = useState(false)
  const [installationOptions, setInstallationOptions] = useState<GithubAppInstallationOption[]>([])
  const [subscriptionAccountId, setSubscriptionAccountId] = useState("")
  const [resourceSearch, setResourceSearch] = useState("")
  const [resources, setResources] = useState<IntegrationResourceRef[]>([])
  const [resourceCursor, setResourceCursor] = useState<string>()
  const [resourceId, setResourceId] = useState("")
  const [selectedEvents, setSelectedEvents] = useState<string[]>([])
  const [inboxEnabled, setInboxEnabled] = useState(false)
  const [projectionId, setProjectionId] = useState("")
  const [ingressSecret, setIngressSecret] = useState("")
  const [ingressUrls, setIngressUrls] = useState<Record<string, string>>({})
  const [deadletters, setDeadletters] = useState<IntegrationIngressDeadLetter[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const [accounts = [], subscriptions = [], jobs = [], audit = []] = snapshot ?? []
  const selected = useMemo(
    () => entries.find((entry) => `${entry.pluginId}:${entry.definition.id}` === selectedKey),
    [entries, selectedKey]
  )
  const selectedStrategy = selected?.definition.authStrategies.find(
    (candidate) => candidate.id === authStrategyId
  )
  const subscriptionAccount = accounts.find((candidate) => candidate.id === subscriptionAccountId)
  const subscriptionEntry = entries.find(
    (entry) =>
      entry.pluginId === subscriptionAccount?.pluginId &&
      entry.definition.id === subscriptionAccount?.integrationId
  )
  const resourceKind = subscriptionEntry?.definition.resourceProvider?.kinds[0]
  const platformSupported = ["tauri", "headless"].includes(detectPlatform())

  useEffect(() => {
    if (accounts.length === 0) return
    let cancelled = false
    void Promise.all(
      accounts.flatMap((account) =>
        account.ingressEndpoint
          ? [
              getIntegrationIngressPublicUrl(account.ingressEndpoint.routeId).then(
                (url) => [account.id, url] as const
              ),
            ]
          : []
      )
    ).then((pairs) => {
      if (!cancelled) {
        setIngressUrls(
          Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => !!pair[1]))
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [accounts])

  useEffect(() => {
    if (!subscriptionAccount) return
    void listIntegrationIngressDeadletters(
      subscriptionAccount.pluginId,
      subscriptionAccount.id
    ).then(setDeadletters)
  }, [subscriptionAccount])

  async function addAccount(event: FormEvent) {
    event.preventDefault()
    if (!selected || !selectedStrategy) return
    if (selectedStrategy.type === "app" && !dedicatedAppConfirmed) {
      setError(t("errors.confirmDedicatedApp"))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const properties = (selectedStrategy.configSchema?.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >
      const configuration = Object.fromEntries(
        Object.entries(authConfiguration).map(([key, value]) => [
          key,
          configuredValue(value, properties[key] ?? {}),
        ])
      )
      const session = await getAuthSession(
        selectedStrategy.providerId,
        selectedStrategy.scopes ?? [],
        { createIfNone: true, forceNewSession: true, configuration }
      )
      if (!session) throw new Error("session")
      const account = await createIntegrationAccount(selected.pluginId, {
        integrationId: selected.definition.id,
        providerId: selectedStrategy.providerId,
        authSessionId: session.id,
        remoteAccountId: session.account.id,
        label: label || session.account.label,
        dedicatedAppConfirmed: selectedStrategy.type === "app" ? dedicatedAppConfirmed : undefined,
      })
      await checkIntegrationAccountHealth(selected.pluginId, account.id)
      setLabel("")
      setAuthConfiguration({})
      setDedicatedAppConfirmed(false)
    } catch {
      setError(t("errors.accountSetup"))
    } finally {
      setBusy(false)
    }
  }

  async function loadResources(cursor?: string) {
    if (!subscriptionAccount || !resourceKind) return
    setBusy(true)
    setError(undefined)
    try {
      const page = await listIntegrationResources(subscriptionAccount.pluginId, {
        accountId: subscriptionAccount.id,
        kind: resourceKind,
        query: resourceSearch || undefined,
        cursor,
        limit: 50,
      })
      setResources(cursor ? [...resources, ...page.items] : page.items)
      setResourceCursor(page.nextCursor)
    } catch {
      setError(t("errors.resourceDiscovery"))
    } finally {
      setBusy(false)
    }
  }

  async function discoverInstallations() {
    setBusy(true)
    setError(undefined)
    try {
      setInstallationOptions(await discoverGithubAppInstallations(authConfiguration))
    } catch {
      setError(t("errors.installationDiscovery"))
    } finally {
      setBusy(false)
    }
  }

  async function addSubscription(event: FormEvent) {
    event.preventDefault()
    if (!subscriptionAccount || selectedEvents.length === 0) return
    if (inboxEnabled && !projectionId) {
      setError(t("errors.projectionRequired"))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      let ingressSecretHandle: string | undefined
      if (subscriptionEntry?.definition.ingress) {
        if (!ingressSecret) throw new Error("secret")
        ingressSecretHandle = crypto.randomUUID()
        await createKeyringStore("integration-ingress").save(ingressSecretHandle, ingressSecret)
      }
      await createIntegrationSubscription(subscriptionAccount.pluginId, {
        integrationId: subscriptionAccount.integrationId,
        accountId: subscriptionAccount.id,
        eventTypes: selectedEvents,
        resourceKind: resourceId ? resourceKind : undefined,
        resourceId: resourceId || undefined,
        inboxProjectionId: inboxEnabled ? projectionId : undefined,
        ingressSecretHandle,
      })
      await syncIntegrationIngressRoutes()
      const refreshedAccount = await getIntegrationAccount(
        subscriptionAccount.pluginId,
        subscriptionAccount.id
      )
      if (
        refreshedAccount?.providerId === "github-app" &&
        refreshedAccount.dedicatedAppConfirmed &&
        refreshedAccount.ingressEndpoint &&
        ingressSecret
      ) {
        const webhookUrl = await getIntegrationIngressPublicUrl(
          refreshedAccount.ingressEndpoint.routeId
        )
        if (webhookUrl) {
          await rotateGithubWebhookSecret(refreshedAccount, webhookUrl, ingressSecret)
        }
      }
      setResourceId("")
      setSelectedEvents([])
      setInboxEnabled(false)
      setProjectionId("")
      setIngressSecret("")
    } catch {
      setError(t("errors.subscriptionSetup"))
    } finally {
      setBusy(false)
    }
  }

  const configProperties = (selectedStrategy?.configSchema?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >
  const requiredConfigFields = Array.isArray(selectedStrategy?.configSchema?.required)
    ? selectedStrategy.configSchema.required.filter(
        (field): field is string => typeof field === "string"
      )
    : []

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6" data-bg-target="chat">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <PlugZapIcon className="size-5" />
          <h1 className="text-xl font-semibold">{t("title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        {!platformSupported && (
          <p className="rounded border border-dashed p-3 text-sm">{t("unsupportedWeb")}</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
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
                {definition.authStrategies.map((strategy, index) => (
                  <Badge key={strategy.id} variant={index === 0 ? "default" : "outline"}>
                    {strategy.label}
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
                onChange={(event) => {
                  setSelectedKey(event.target.value)
                  setAuthStrategyId("")
                  setAuthConfiguration({})
                }}
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
              <Label>{t("accounts.authStrategy")}</Label>
              <div className="grid gap-2">
                {(selected?.definition.authStrategies ?? []).map((strategy, index) => (
                  <Button
                    key={strategy.id}
                    type="button"
                    variant={authStrategyId === strategy.id ? "default" : "outline"}
                    className="justify-between"
                    onClick={() => {
                      setAuthStrategyId(strategy.id)
                      setAuthConfiguration({})
                    }}
                  >
                    <span>{strategy.label}</span>
                    <span className="text-xs">
                      {index === 0 ? t("accounts.recommended") : t("accounts.advanced")}
                    </span>
                  </Button>
                ))}
              </div>
              {Object.entries(configProperties)
                .filter(
                  ([key]) =>
                    !(selectedStrategy?.providerId === "github-app" && key === "installationId")
                )
                .map(([key, schema]) => {
                  const translation =
                    CONFIG_FIELD_TRANSLATIONS[key as keyof typeof CONFIG_FIELD_TRANSLATIONS]
                  const fieldLabel = translation
                    ? t(translation)
                    : typeof schema.title === "string"
                      ? schema.title
                      : key
                  return (
                    <div key={key} className="grid gap-1">
                      <Label htmlFor={`auth-${key}`}>{fieldLabel}</Label>
                      <Input
                        id={`auth-${key}`}
                        type={
                          schema.format === "secret"
                            ? "password"
                            : schema.type === "integer"
                              ? "number"
                              : "text"
                        }
                        required={requiredConfigFields.includes(key)}
                        value={authConfiguration[key] ?? ""}
                        onChange={(event) =>
                          setAuthConfiguration((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  )
                })}
              {selectedStrategy?.providerId === "github-app" && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !authConfiguration.appId || !authConfiguration.privateKey}
                    onClick={discoverInstallations}
                  >
                    {t("accounts.discoverInstallations")}
                  </Button>
                  <select
                    aria-label={t("accounts.installation")}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={authConfiguration.installationId ?? ""}
                    onChange={(event) => {
                      const installation = installationOptions.find(
                        (candidate) => candidate.id === event.target.value
                      )
                      setAuthConfiguration((current) => ({
                        ...current,
                        installationId: event.target.value,
                        accountLabel: installation?.label ?? current.accountLabel,
                      }))
                    }}
                  >
                    <option value="">{t("accounts.selectInstallation")}</option>
                    {installationOptions.map((installation) => (
                      <option key={installation.id} value={installation.id}>
                        {installation.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {selectedStrategy?.type === "app" && (
                <Label className="flex items-start gap-2 font-normal">
                  <Checkbox
                    checked={dedicatedAppConfirmed}
                    onCheckedChange={(checked) => setDedicatedAppConfirmed(checked === true)}
                  />
                  <span>{t("accounts.dedicatedAppConfirmation")}</span>
                </Label>
              )}
              <Button type="submit" disabled={busy || !platformSupported}>
                {t("accounts.validateAndAdd")}
              </Button>
            </form>

            <div className="space-y-2">
              {accounts.map((account) => {
                const missing = (account.status?.requiredPermissions ?? []).filter(
                  (permission) => !(account.status?.grantedPermissions ?? []).includes(permission)
                )
                const githubStatusTranslation =
                  account.pluginId === "github-delivery" && account.status?.code
                    ? GITHUB_STATUS_TRANSLATIONS[
                        account.status.code as keyof typeof GITHUB_STATUS_TRANSLATIONS
                      ]
                    : undefined
                return (
                  <div key={account.id} className="space-y-2 rounded border p-3">
                    <div className="flex items-center justify-between gap-3">
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
                          aria-label={t("accounts.checkHealth")}
                          onClick={() =>
                            checkIntegrationAccountHealth(account.pluginId, account.id)
                          }
                        >
                          <RefreshCwIcon className="size-3" />
                        </Button>
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
                    <div className="grid gap-1 text-xs text-muted-foreground">
                      {ingressUrls[account.id] && (
                        <p>
                          {t("accounts.webhookUrl")}: {ingressUrls[account.id]}
                        </p>
                      )}
                      <p>
                        {t("accounts.webhookVerification")}:{" "}
                        {account.ingressEndpoint
                          ? t("accounts.configured")
                          : t("accounts.notConfigured")}
                      </p>
                      {account.status?.lastSyncAt && (
                        <p>
                          {t("accounts.lastSync")}:{" "}
                          {new Date(account.status.lastSyncAt).toLocaleString()}
                        </p>
                      )}
                      {account.status?.rateLimit?.resetAt && (
                        <p>
                          {t("accounts.rateLimitReset")}:{" "}
                          {new Date(account.status.rateLimit.resetAt).toLocaleString()}
                        </p>
                      )}
                      {missing.length > 0 && (
                        <p className="text-destructive">
                          {t("accounts.missingPermissions")}: {missing.join(", ")}
                        </p>
                      )}
                      {githubStatusTranslation ? (
                        <p>{t(githubStatusTranslation)}</p>
                      ) : account.pluginId !== "github-delivery" && account.status?.message ? (
                        <p>{account.status.message}</p>
                      ) : null}
                    </div>
                  </div>
                )
              })}
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
                onChange={(event) => {
                  setSubscriptionAccountId(event.target.value)
                  setResources([])
                  setResourceId("")
                  setSelectedEvents([])
                }}
              >
                <option value="">{t("subscriptions.selectAccount")}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </select>
              {resourceKind && (
                <>
                  <div className="flex gap-2">
                    <Input
                      aria-label={t("subscriptions.searchResources")}
                      placeholder={t("subscriptions.searchResources")}
                      value={resourceSearch}
                      onChange={(event) => setResourceSearch(event.target.value)}
                    />
                    <Button type="button" variant="outline" onClick={() => loadResources()}>
                      {t("subscriptions.discover")}
                    </Button>
                  </div>
                  <select
                    aria-label={t("subscriptions.repository")}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={resourceId}
                    onChange={(event) => setResourceId(event.target.value)}
                  >
                    <option value="">{t("subscriptions.allResources")}</option>
                    {resources.map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.name}
                      </option>
                    ))}
                  </select>
                  {resourceCursor && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => loadResources(resourceCursor)}
                    >
                      {t("subscriptions.loadMore")}
                    </Button>
                  )}
                </>
              )}
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">{t("subscriptions.events")}</legend>
                {(subscriptionEntry?.definition.eventTypes ?? []).map((eventType) => {
                  const translation =
                    subscriptionEntry?.pluginId === "github-delivery"
                      ? GITHUB_EVENT_TRANSLATIONS[
                          eventType.id as keyof typeof GITHUB_EVENT_TRANSLATIONS
                        ]
                      : undefined
                  return (
                    <Label key={eventType.id} className="flex items-center gap-2 font-normal">
                      <Checkbox
                        checked={selectedEvents.includes(eventType.id)}
                        onCheckedChange={(checked) =>
                          setSelectedEvents((current) =>
                            checked === true
                              ? [...new Set([...current, eventType.id])]
                              : current.filter((id) => id !== eventType.id)
                          )
                        }
                      />
                      <span>{translation ? t(translation) : eventType.label}</span>
                    </Label>
                  )
                })}
              </fieldset>
              {(subscriptionEntry?.definition.inboxProjections?.length ?? 0) > 0 && (
                <>
                  <Label className="flex items-center gap-2 font-normal">
                    <Checkbox
                      checked={inboxEnabled}
                      onCheckedChange={(checked) => setInboxEnabled(checked === true)}
                    />
                    <span>{t("subscriptions.deliverToInbox")}</span>
                  </Label>
                  {inboxEnabled && (
                    <select
                      aria-label={t("subscriptions.projection")}
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      value={projectionId}
                      onChange={(event) => setProjectionId(event.target.value)}
                    >
                      <option value="">{t("subscriptions.selectProjection")}</option>
                      {subscriptionEntry?.definition.inboxProjections?.map((projection) => {
                        const translation =
                          subscriptionEntry.pluginId === "github-delivery"
                            ? GITHUB_PROJECTION_TRANSLATIONS[
                                projection.id as keyof typeof GITHUB_PROJECTION_TRANSLATIONS
                              ]
                            : undefined
                        return (
                          <option key={projection.id} value={projection.id}>
                            {translation ? t(translation) : projection.label}
                          </option>
                        )
                      })}
                    </select>
                  )}
                </>
              )}
              {subscriptionEntry?.definition.ingress && (
                <Input
                  type="password"
                  aria-label={t("subscriptions.ingressSecret")}
                  placeholder={t("subscriptions.ingressSecret")}
                  value={ingressSecret}
                  onChange={(event) => setIngressSecret(event.target.value)}
                />
              )}
              <Button type="submit" disabled={busy || !platformSupported}>
                {t("subscriptions.add")}
              </Button>
            </form>
            {subscriptions
              .filter(
                (subscription) =>
                  !subscriptionAccountId || subscription.accountId === subscriptionAccountId
              )
              .map((subscription) => (
                <div
                  key={subscription.id}
                  className="flex items-center justify-between rounded border p-3"
                >
                  <div className="text-xs">
                    <p className="font-medium">{subscription.eventTypes.join(", ")}</p>
                    <p className="text-muted-foreground">
                      {subscription.resourceId || t("subscriptions.allResources")}
                    </p>
                    {subscription.disabledByProvider && (
                      <p className="text-destructive">{t("subscriptions.disabledByProvider")}</p>
                    )}
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
            <div className="space-y-2">
              <p className="text-sm font-medium">{t("subscriptions.failedDeliveries")}</p>
              {deadletters.map((delivery) => (
                <div
                  key={`${delivery.routeId}:${delivery.deliveryId}`}
                  className="flex items-center justify-between text-xs"
                >
                  <span>
                    {delivery.deliveryId} · {delivery.attempts}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      if (!subscriptionAccount) return
                      await requeueIntegrationIngressDeadletter(
                        subscriptionAccount.pluginId,
                        subscriptionAccount.id,
                        delivery.routeId,
                        delivery.deliveryId
                      )
                      setDeadletters(
                        await listIntegrationIngressDeadletters(
                          subscriptionAccount.pluginId,
                          subscriptionAccount.id
                        )
                      )
                    }}
                  >
                    {t("subscriptions.requeue")}
                  </Button>
                </div>
              ))}
              {deadletters.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("subscriptions.noFailedDeliveries")}
                </p>
              )}
            </div>
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
