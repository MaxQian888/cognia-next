"use client"

/**
 * One template instance, with the lifecycle its service has always supported.
 *
 * The Instances tab was a read-only card carrying an id, a version and a
 * `detached` badge. Meanwhile `TemplateService` shipped `planUpdate`,
 * `applyUpdate`, `detachInstance` and `rebindSource`, and ADR-0100 advertises
 * "preflight, instantiate, diff, update, detach" as the full-domain lifecycle.
 * Four of those five had no caller anywhere in the app, so an instance created
 * from a template could never be moved to a newer release of it.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"

/** A release an instance could be pointed at instead of the one it has. */
export interface TemplateRebindTarget {
  id: string
  version: string
  name: string
  domain: string
}

export interface TemplateInstanceCardProps {
  instance: TemplateInstanceRecord
  /**
   * What to call this instance. Defaults to the raw definition id, which is
   * the right answer in the Studio, where the id IS what the user selected.
   * A host that already knows the human name of the thing (the Squad library
   * says "Created from Parallel review v1.2.0") passes it instead of forking
   * the card, so the lifecycle controls below stay in one place.
   */
  title?: string
  /**
   * Replaces the bare version line. Same reasoning as `title`: a host with a
   * fuller sentence to say says it here rather than reimplementing the card.
   */
  summary?: ReactNode
  /** Released versions of the definition this instance came from, newest last. */
  availableVersions: string[]
  /**
   * Every release that could take over as this instance's source. Filtered to
   * the instance's own domain here, because `rebindSource` refuses a
   * cross-domain move and offering one would only surface that refusal.
   */
  rebindTargets?: TemplateRebindTarget[]
  onPlanUpdate: (instanceId: string, version: string) => void
  onDetach: (instanceId: string) => void
  onRebind?: (instanceId: string, definitionId: string, version: string) => void
  busy?: boolean
}

export function TemplateInstanceCard({
  instance,
  title,
  summary,
  availableVersions,
  rebindTargets = [],
  onPlanUpdate,
  onDetach,
  onRebind,
  busy = false,
}: TemplateInstanceCardProps) {
  const t = useTranslations("templateStudio")
  const current = instance.source.version
  // Only forward: `planUpdate` refuses a yanked release and a detached
  // instance, and offering a downgrade would just surface those refusals.
  const newer = availableVersions.filter((version) => version !== current)
  const detached = !!instance.detachedAt
  const orphaned = detached || Boolean(instance.sourceUnavailableAt)
  const domain = instance.source.snapshot.domain
  const reboundCandidates = rebindTargets.filter(
    (target) =>
      target.domain === domain &&
      !(target.id === instance.source.definitionId && target.version === instance.source.version)
  )

  return (
    <Card data-testid={`template-instance-${instance.id}`}>
      <CardHeader>
        <CardTitle className="text-base">{title ?? instance.source.definitionId}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        {summary ?? <p>{current ?? t("status.draft")}</p>}
        <p>{t("instances.resources", { count: instance.resources.length })}</p>
        {detached ? <Badge variant="outline">{t("instances.detached")}</Badge> : null}
        {instance.sourceUnavailableAt ? (
          <Badge variant="outline">{t("instances.sourceUnavailable")}</Badge>
        ) : null}
        {!detached ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {newer.length > 0 ? (
              <Select
                onValueChange={(version) => onPlanUpdate(instance.id, version)}
                disabled={busy}
              >
                <SelectTrigger
                  className="h-8 w-44"
                  aria-label={t("instances.updateTo")}
                  data-testid={`template-instance-update-${instance.id}`}
                >
                  <SelectValue placeholder={t("instances.updateTo")} />
                </SelectTrigger>
                <SelectContent>
                  {newer.map((version) => (
                    <SelectItem key={version} value={version}>
                      {version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-xs">{t("instances.upToDate")}</span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => onDetach(instance.id)}
              disabled={busy}
              data-testid={`template-instance-detach-${instance.id}`}
            >
              {t("instances.detach")}
            </Button>
          </div>
        ) : null}
        {/* `rebindSource` had no caller at all, so an instance whose package was
            removed, or one deliberately detached, was stuck in that state
            forever. It also clears both marks, which is what makes it the way
            back rather than a second kind of detach. */}
        {orphaned && onRebind && reboundCandidates.length > 0 ? (
          <div className="pt-1">
            <Select
              onValueChange={(value) => {
                const [id, version] = value.split("@@")
                onRebind(instance.id, id, version)
              }}
              disabled={busy}
            >
              <SelectTrigger
                className="h-8 w-full"
                aria-label={t("instances.rebindTo")}
                data-testid={`template-instance-rebind-${instance.id}`}
              >
                <SelectValue placeholder={t("instances.rebindTo")} />
              </SelectTrigger>
              <SelectContent>
                {reboundCandidates.map((target) => (
                  <SelectItem
                    key={`${target.id}@${target.version}`}
                    value={`${target.id}@@${target.version}`}
                  >
                    {target.name} {target.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
