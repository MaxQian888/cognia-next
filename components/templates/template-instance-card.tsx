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

export interface TemplateInstanceCardProps {
  instance: TemplateInstanceRecord
  /** Released versions of the definition this instance came from, newest last. */
  availableVersions: string[]
  onPlanUpdate: (instanceId: string, version: string) => void
  onDetach: (instanceId: string) => void
  busy?: boolean
}

export function TemplateInstanceCard({
  instance,
  availableVersions,
  onPlanUpdate,
  onDetach,
  busy = false,
}: TemplateInstanceCardProps) {
  const t = useTranslations("templateStudio")
  const current = instance.source.version
  // Only forward: `planUpdate` refuses a yanked release and a detached
  // instance, and offering a downgrade would just surface those refusals.
  const newer = availableVersions.filter((version) => version !== current)
  const detached = !!instance.detachedAt

  return (
    <Card data-testid={`template-instance-${instance.id}`}>
      <CardHeader>
        <CardTitle className="text-base">{instance.source.definitionId}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>{current ?? t("status.draft")}</p>
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
      </CardContent>
    </Card>
  )
}
