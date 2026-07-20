"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { updateSiteAuthoringPolicy } from "@/lib/db/sites"
import type { CloudflareSitesService } from "@/lib/sites/cloudflare/service"
import type {
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVisitorPolicy,
} from "@/types/sites"

function splitValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

const ACCESS_MODES: SiteVisitorPolicy["mode"][] = [
  "private",
  "identities",
  "domains",
  "organization",
  "public",
]

export interface SiteAdvancedPanelProps {
  site: SiteProjectRow
  resources: SiteResourceRow[]
  operations: SiteOperationRow[]
  events: SiteOperationEventRow[]
  service: () => CloudflareSitesService
  actorAccountId: string
  busy: string | null
  act: (key: string, action: () => Promise<void>) => Promise<void>
}

/**
 * Power-user configuration relocated out of the old tab bar into a single
 * collapsible drawer: visitor access, custom domains, provider token +
 * authoring policy, provider observability, and the durable operation journal.
 * Behavior is unchanged from the previous console — this is a home, not a
 * rewrite. Seeded form state is initialized from the site row and the panel is
 * remounted per site (`key={site.id}`) so switching sites re-seeds without a
 * set-state-in-effect.
 */
export function SiteAdvancedPanel({
  site,
  resources,
  operations,
  events,
  service,
  actorAccountId,
  busy,
  act,
}: SiteAdvancedPanelProps) {
  const t = useTranslations("sites")
  const [accessMode, setAccessMode] = useState<SiteVisitorPolicy["mode"]>(site.visitorPolicy.mode)
  const [accessValues, setAccessValues] = useState("")
  const [accessHostname, setAccessHostname] = useState("")
  const [domain, setDomain] = useState("")
  const [editorAccounts, setEditorAccounts] = useState(
    site.authoringPolicy.editorAccountIds.join("\n")
  )
  const [deployerAccounts, setDeployerAccounts] = useState(
    site.authoringPolicy.deployerAccountIds.join("\n")
  )
  const [output, setOutput] = useState("")

  const saveAccess = () =>
    act("access", async () => {
      let policy: SiteVisitorPolicy
      if (accessMode === "identities")
        policy = { mode: accessMode, emails: splitValues(accessValues) }
      else if (accessMode === "domains")
        policy = { mode: accessMode, domains: splitValues(accessValues) }
      else if (accessMode === "organization")
        policy = { mode: accessMode, organizationId: accessValues.trim() }
      else policy = { mode: accessMode }
      await service().reconcileVisitorAccess(site.id, policy, accessHostname)
    })

  const observe = (kind: "logs" | "analytics") =>
    act(kind, async () => {
      const now = Date.now()
      const result =
        kind === "logs"
          ? await service().logs(site.id, now - 24 * 60 * 60 * 1000, now)
          : await service().analytics(
              site.id,
              new Date(now - 24 * 60 * 60 * 1000).toISOString(),
              new Date(now).toISOString()
            )
      setOutput(JSON.stringify(result, null, 2))
    })

  return (
    <Collapsible className="rounded-xl border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 p-4 text-left text-sm font-medium">
        {t("advanced.title")}
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t p-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("access.title")}</CardTitle>
            <CardDescription>{t("access.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={accessMode}
              onChange={(event) => setAccessMode(event.target.value as SiteVisitorPolicy["mode"])}
              aria-label={t("access.mode")}
            >
              {ACCESS_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`access.modes.${mode}`)}
                </option>
              ))}
            </select>
            <Input
              value={accessHostname}
              onChange={(event) => setAccessHostname(event.target.value)}
              placeholder={t("access.hostname")}
            />
            <Textarea
              value={accessValues}
              onChange={(event) => setAccessValues(event.target.value)}
              placeholder={t("access.values")}
            />
            <Button onClick={saveAccess} disabled={busy !== null}>
              {t("actions.saveAccess")}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("domains.title")}</CardTitle>
            <CardDescription>{t("domains.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder={t("domains.hostname")}
              />
              <Button
                onClick={() =>
                  act("domain", async () => void (await service().addDomain(site.id, domain)))
                }
                disabled={busy !== null}
              >
                {t("actions.addDomain")}
              </Button>
            </div>
            {resources
              .filter((row) => row.kind === "custom-domain" && row.status === "active")
              .map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <span>{row.displayName}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      act(`remove:${row.id}`, async () => service().removeDomain(site.id, row.id))
                    }
                  >
                    {t("actions.remove")}
                  </Button>
                </div>
              ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("provider.title")}</CardTitle>
            <CardDescription>{t("provider.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              variant="outline"
              onClick={() =>
                act("reconcile", async () => {
                  setOutput(JSON.stringify(await service().reconcile(site.id), null, 2))
                })
              }
              disabled={busy !== null}
            >
              {t("actions.reconcile")}
            </Button>
            <div className="grid gap-2 text-sm md:grid-cols-2">
              <div>
                {t("provider.account")}: {site.providerConfig.accountId}
              </div>
              <div>
                {t("provider.worker")}: {site.providerConfig.workerName}
              </div>
            </div>
            <Separator />
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>{t("authoring.editors")}</Label>
                <Textarea
                  className="mt-2"
                  value={editorAccounts}
                  onChange={(event) => setEditorAccounts(event.target.value)}
                  placeholder={t("authoring.accountsPlaceholder")}
                />
              </div>
              <div>
                <Label>{t("authoring.deployers")}</Label>
                <Textarea
                  className="mt-2"
                  value={deployerAccounts}
                  onChange={(event) => setDeployerAccounts(event.target.value)}
                  placeholder={t("authoring.accountsPlaceholder")}
                />
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  act("authoring", async () => {
                    await updateSiteAuthoringPolicy(site.id, actorAccountId, {
                      ownerAccountId: site.authoringPolicy.ownerAccountId,
                      editorAccountIds: splitValues(editorAccounts),
                      deployerAccountIds: splitValues(deployerAccounts),
                    })
                  })
                }
                disabled={busy !== null}
              >
                {t("actions.saveAuthoring")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("observability.title")}</CardTitle>
            <CardDescription>{t("observability.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => observe("logs")} disabled={busy !== null}>
                {t("actions.loadLogs")}
              </Button>
              <Button
                variant="outline"
                onClick={() => observe("analytics")}
                disabled={busy !== null}
              >
                {t("actions.loadAnalytics")}
              </Button>
            </div>
            <pre className="max-h-[500px] overflow-auto rounded-lg bg-muted p-4 text-xs">
              {output || t("observability.empty")}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("operations.title")}</CardTitle>
            <CardDescription>{t("operations.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {operations.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("operations.empty")}</p>
            ) : (
              operations.map((operation) => (
                <div key={operation.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span>{t(`operationType.${operation.type}`)}</span>
                    <Badge variant="secondary">{t(`operationStatus.${operation.status}`)}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("operations.eventCount", {
                      count: events.filter((event) => event.operationId === operation.id).length,
                    })}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  )
}
