"use client"

/**
 * Custom domains, provider identity, and the visitor access policy.
 *
 * Two long-standing dead ends are fixed here. `providerConfig.zoneId` had no UI
 * anywhere, so `addDomain` threw "Cloudflare zone id is required" for every Site
 * created in the app — the button could never succeed. And the access form
 * seeded its value box to an empty string regardless of the stored policy, so
 * applying a policy without retyping silently erased the identity, domain, or
 * organization list it was supposed to preserve.
 */
import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ExternalLinkIcon,
  GlobeIcon,
  InfoIcon,
  PlusIcon,
  ShieldIcon,
  TrashIcon,
} from "lucide-react"

import { ExternalLink } from "@/components/shared/external-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  siteAccessLoginUrl,
  siteAccessTeamMissing,
  siteIsAccessProtected,
} from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import type { SiteProjectRow, SiteResourceRow, SiteVisitorPolicy } from "@/types/sites"
import { splitValues } from "../split-values"
import { SITE_RESOURCE_FACE, SiteStatusPill } from "../site-status"

const ACCESS_MODES: SiteVisitorPolicy["mode"][] = [
  "private",
  "identities",
  "domains",
  "organization",
  "public",
]

/** The stored policy's values, so re-applying cannot silently clear the list. */
function seedAccessValues(policy: SiteVisitorPolicy): string {
  if (policy.mode === "identities") return policy.emails.join("\n")
  if (policy.mode === "domains") return policy.domains.join("\n")
  if (policy.mode === "organization") return policy.organizationId
  return ""
}

export interface SiteDomainsTabProps {
  site: SiteProjectRow
  resources: readonly SiteResourceRow[]
  gate: SiteGate
  /**
   * Per-key busy predicate from `useSiteActions`. `isBusy(key)` is true while
   * that action is in flight or an exclusive lifecycle action is running; a
   * build no longer disables unrelated controls.
   */
  isBusy: (key?: string) => boolean
  onAddDomain: (hostname: string) => void
  onRemoveDomain: (resourceId: string) => void
  onSaveProviderConfig: (patch: { zoneId?: string; accessTeamName?: string }) => void
  onApplyAccess: (policy: SiteVisitorPolicy, hostname: string) => void
}

export function SiteDomainsTab({
  site,
  resources,
  gate,
  isBusy,
  onAddDomain,
  onRemoveDomain,
  onSaveProviderConfig,
  onApplyAccess,
}: SiteDomainsTabProps) {
  const t = useTranslations("sites")

  const [zoneId, setZoneId] = useState(site.providerConfig.zoneId ?? "")
  const [accessTeamName, setAccessTeamName] = useState(site.providerConfig.accessTeamName ?? "")
  const [hostname, setHostname] = useState("")
  const [accessMode, setAccessMode] = useState<SiteVisitorPolicy["mode"]>(site.visitorPolicy.mode)
  const [accessValues, setAccessValues] = useState(() => seedAccessValues(site.visitorPolicy))
  const [accessHostname, setAccessHostname] = useState("")

  const zoneMissing = !site.providerConfig.zoneId?.trim()
  const accessLoginUrl = siteAccessLoginUrl(site.providerConfig)
  const accessTeamMissing = siteAccessTeamMissing(site.visitorPolicy, site.providerConfig)
  const accessProtected = siteIsAccessProtected(site.visitorPolicy)
  const domains = resources.filter(
    (row) => row.kind === "custom-domain" && row.status !== "deleted"
  )

  const compilePolicy = (): SiteVisitorPolicy => {
    if (accessMode === "identities") return { mode: accessMode, emails: splitValues(accessValues) }
    if (accessMode === "domains") return { mode: accessMode, domains: splitValues(accessValues) }
    if (accessMode === "organization")
      return { mode: accessMode, organizationId: accessValues.trim() }
    return { mode: accessMode }
  }

  return (
    <div className="space-y-4" data-testid="site-domains-tab">
      <section className="rounded-xl border">
        <header className="border-b px-3 py-2">
          <h3 className="text-sm font-medium">{t("provider.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("provider.identityLocked")}</p>
        </header>
        <div className="grid gap-3 p-3 md:grid-cols-2">
          <div className="text-xs">
            <span className="text-muted-foreground">{t("provider.account")}: </span>
            <code className="font-mono">{site.providerConfig.accountId}</code>
          </div>
          <div className="text-xs">
            <span className="text-muted-foreground">{t("provider.worker")}: </span>
            <code className="font-mono">{site.providerConfig.workerName}</code>
          </div>
          <div>
            <Label htmlFor="site-zone-id">{t("provider.zoneId")}</Label>
            <Input
              id="site-zone-id"
              className="mt-1"
              value={zoneId}
              onChange={(event) => setZoneId(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("provider.zoneIdHint")}</p>
          </div>
          <div>
            <Label htmlFor="site-access-team">{t("provider.accessTeamName")}</Label>
            <Input
              id="site-access-team"
              className="mt-1"
              value={accessTeamName}
              onChange={(event) => setAccessTeamName(event.target.value)}
            />
            <p
              className={cn(
                "mt-1 text-xs",
                accessTeamMissing ? "text-warning" : "text-muted-foreground"
              )}
            >
              {t("provider.accessTeamNameHint")}
            </p>
          </div>
          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isBusy("provider-config") || !gate.allowed}
              title={gate.title}
              onClick={() => onSaveProviderConfig({ zoneId, accessTeamName })}
              data-testid="site-save-provider-config"
            >
              {t("actions.saveProviderConfig")}
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border">
        <header className="border-b px-3 py-2">
          <h3 className="text-sm font-medium">{t("domains.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("domains.description")}</p>
        </header>
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-0 flex-1"
              value={hostname}
              placeholder={t("domains.hostname")}
              aria-label={t("domains.title")}
              onChange={(event) => setHostname(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={isBusy("domain") || !gate.allowed || !hostname.trim() || zoneMissing}
              title={zoneMissing ? t("provider.zoneIdRequired") : gate.title}
              onClick={() => onAddDomain(hostname.trim())}
              data-testid="site-add-domain"
            >
              <PlusIcon aria-hidden className="size-4" />
              {t("actions.addDomain")}
            </Button>
          </div>

          {zoneMissing ? (
            <p
              className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning"
              data-testid="site-zone-missing"
            >
              <InfoIcon aria-hidden className="size-3.5 shrink-0" />
              {t("provider.zoneIdRequired")}
            </p>
          ) : null}

          {domains.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
              data-testid={`site-domain-${row.id}`}
            >
              <GlobeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{row.displayName}</span>
              <SiteStatusPill
                face={SITE_RESOURCE_FACE[row.status]}
                label={t(`resources.status.${row.status}`)}
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={t("actions.remove")}
                disabled={isBusy(`remove:${row.id}`) || !gate.allowed}
                title={gate.title}
                onClick={() => onRemoveDomain(row.id)}
              >
                <TrashIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border">
        <header className="border-b px-3 py-2">
          <h3 className="text-sm font-medium">{t("access.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("access.description")}</p>
        </header>
        <div className="space-y-3 p-3">
          <fieldset>
            <legend className="sr-only">{t("access.mode")}</legend>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {ACCESS_MODES.map((mode) => (
                <label
                  key={mode}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-2 text-xs transition-colors hover:bg-accent/50 motion-reduce:transition-none",
                    accessMode === mode && "border-primary bg-primary/5 ring-1 ring-primary/40"
                  )}
                >
                  <input
                    type="radio"
                    name="site-access-mode"
                    value={mode}
                    checked={accessMode === mode}
                    onChange={() => {
                      setAccessMode(mode)
                      // Re-seed from the stored policy when the user returns to
                      // the mode that is actually saved, so switching back and
                      // forth never quietly empties the list.
                      setAccessValues(
                        mode === site.visitorPolicy.mode ? seedAccessValues(site.visitorPolicy) : ""
                      )
                    }}
                    className="size-3.5"
                  />
                  <ShieldIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{t(`access.modes.${mode}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {accessMode === "identities" ||
          accessMode === "domains" ||
          accessMode === "organization" ? (
            <div>
              <Label htmlFor="site-access-values">{t("access.values")}</Label>
              <Textarea
                id="site-access-values"
                className="mt-1 min-h-20 font-mono text-xs"
                value={accessValues}
                placeholder={t("access.values")}
                onChange={(event) => setAccessValues(event.target.value)}
              />
            </div>
          ) : (
            <Badge variant="outline" className="font-normal">
              {t(`access.modes.${accessMode}`)}
            </Badge>
          )}

          {accessProtected ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
              data-testid="site-access-login"
            >
              <ShieldIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">{t("access.loginLabel")}</span>
              {accessLoginUrl ? (
                <ExternalLink
                  href={accessLoginUrl}
                  className="inline-flex min-w-0 items-center gap-1 truncate font-mono underline-offset-4 hover:text-primary hover:underline"
                >
                  {accessLoginUrl}
                  <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
                </ExternalLink>
              ) : (
                <span className="text-warning" data-testid="site-access-team-missing">
                  {t("access.loginUnknown")}
                </span>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Label htmlFor="site-access-hostname">{t("access.hostname")}</Label>
              <Input
                id="site-access-hostname"
                className="mt-1"
                value={accessHostname}
                placeholder={t("domains.hostname")}
                onChange={(event) => setAccessHostname(event.target.value)}
              />
            </div>
            <Button
              type="button"
              size="sm"
              disabled={isBusy("access") || !gate.allowed}
              title={gate.title}
              onClick={() => onApplyAccess(compilePolicy(), accessHostname)}
              data-testid="site-apply-access"
            >
              {t("actions.saveAccess")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
