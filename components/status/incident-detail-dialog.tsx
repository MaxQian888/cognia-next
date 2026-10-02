"use client"

/**
 * One incident with its full, append-only update timeline.
 *
 * Opened from the page's `?incident=<id>` query (deep links and reloads) or
 * from an incident card. Updates are shown newest first; a correction is
 * labelled as one. A missing incident is a plain "not found" message.
 */

import { useLocale, useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import type { IncidentDetailState } from "@/hooks/status/use-incident-detail"
import { pickLocalized, sortIncidentUpdatesNewestFirst } from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import { STATUS_STYLES, StatusLabel } from "./status-labels"
import { formatList, formatUtcDateTime } from "./status-format"

export function IncidentDetailDialog({ state }: { state: IncidentDetailState }) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const open = state.status !== "idle"
  const detail = state.status === "ready" ? state.detail : null
  const title = detail ? pickLocalized(detail.title, locale) : t("incidents.detailTitle")
  const components = (ids: readonly string[]) =>
    formatList(
      ids.map((id) => t(`components.${id}.name`)),
      locale
    )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) state.close()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
        data-testid="incident-dialog"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div>
              {state.status === "loading" ? (
                <span role="status">{t("incidents.detailLoading")}</span>
              ) : state.status === "not_found" ? (
                <span role="alert">{t("incidents.detailNotFound")}</span>
              ) : state.status === "invalid" ? (
                <span role="alert">{t("incidents.detailInvalid")}</span>
              ) : state.status === "error" ? (
                <span role="alert">
                  {t("incidents.detailError")}{" "}
                  {state.errorKind ? t(`error.kinds.${state.errorKind}`) : null}
                </span>
              ) : detail ? (
                <span className="flex flex-wrap items-center gap-2">
                  <StatusLabel status={detail.impact} />
                  <Badge variant="outline" className="font-normal">
                    {t(`incidentStates.${detail.state}`)}
                  </Badge>
                  <span>{t(`incidents.source.${detail.source}`)}</span>
                </span>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        {state.status === "loading" ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}

        {detail ? (
          <div className="space-y-5">
            {detail.componentIds.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("incidents.components", { components: components(detail.componentIds) })}
              </p>
            ) : null}
            <p className="grid gap-0.5 font-mono text-xs text-muted-foreground tabular-nums">
              <span>
                {t("incidents.startedAt", { time: formatUtcDateTime(detail.startedAt, locale) })}
              </span>
              {detail.resolvedAt ? (
                <span>
                  {t("incidents.resolvedAt", {
                    time: formatUtcDateTime(detail.resolvedAt, locale),
                  })}
                </span>
              ) : null}
            </p>
            {detail.predecessorId ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => state.open(detail.predecessorId!)}
              >
                {t("incidents.predecessor")}
              </Button>
            ) : null}
            <div>
              <h3 className="text-sm font-medium">{t("incidents.updatesTitle")}</h3>
              <ol className="mt-4 space-y-0" data-testid="incident-updates">
                {sortIncidentUpdatesNewestFirst(detail.updates).map((update, index, updates) => (
                  <li
                    key={update.id}
                    className="relative grid grid-cols-[auto_1fr] gap-4 pb-6 last:pb-0"
                  >
                    {index < updates.length - 1 ? (
                      <span
                        aria-hidden
                        className="absolute top-4 bottom-0 left-[5px] w-px bg-border"
                      />
                    ) : null}
                    <span
                      aria-hidden
                      className={cn(
                        "relative z-10 mt-1.5 size-3 rounded-full border-2 border-background",
                        STATUS_STYLES[update.state === "resolved" ? "operational" : update.impact]
                          .dot
                      )}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-medium" data-testid="incident-update-state">
                          {t(`incidentStates.${update.state}`)}
                        </span>
                        <time
                          dateTime={update.at}
                          className="font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          {formatUtcDateTime(update.at, locale)}
                        </time>
                        <span className="text-xs text-muted-foreground">
                          {t(`incidents.source.${update.source}`)}
                        </span>
                      </div>
                      {update.correctionOf ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("incidents.correction")}
                        </p>
                      ) : null}
                      <p className="mt-2 text-sm leading-6 whitespace-pre-line text-muted-foreground">
                        {pickLocalized(update.message, locale)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {state.status === "error" ? (
            <Button variant="outline" onClick={state.retry}>
              {t("actions.retry")}
            </Button>
          ) : null}
          <Button variant="outline" onClick={state.close}>
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
