"use client"

/**
 * The right rail of the Servers workspace: every operation this session knows
 * about, newest first.
 *
 * Session-scoped by necessity, not by choice — the controller has no endpoint
 * that lists operations, so an operation becomes visible either because this
 * client queued it or because it arrived on the live event stream. The empty
 * state says so rather than implying the fleet is idle.
 */

import { useTranslations } from "next-intl"
import { ChevronRightIcon, RadioIcon, RadioTowerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Operation } from "@/lib/server-ops/client"
import { cn } from "@/lib/utils"
import { OperationStateBadge, useRelativeTime } from "./server-visuals"

export function OperationsRail({
  operations,
  liveEvents,
  eventStreamConnected,
  selectedId,
  onSelect,
  /** Set on the detail route so the rail shows only that server's work. */
  targetId,
}: {
  operations: readonly Operation[]
  liveEvents: boolean
  eventStreamConnected: boolean
  selectedId: string | null
  onSelect: (operation: Operation) => void
  targetId?: string
}) {
  const t = useTranslations("servers")
  const relative = useRelativeTime()
  const visible = targetId
    ? operations.filter((operation) => operation.targetId === targetId)
    : operations

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <span className="text-sm font-semibold">{t("operations.title")}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-xs",
                liveEvents && eventStreamConnected
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              )}
            >
              {liveEvents ? (
                <RadioTowerIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <RadioIcon className="size-3.5" aria-hidden="true" />
              )}
              {liveEvents
                ? eventStreamConnected
                  ? t("connection.eventsConnected")
                  : t("connection.eventsReconnecting")
                : t("connection.eventsPolled")}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {liveEvents ? t("connection.eventsLiveHelp") : t("connection.eventsPolledHelp")}
          </TooltipContent>
        </Tooltip>
      </div>

      {visible.length === 0 ? (
        <Empty className="flex-1">
          <EmptyTitle>{t("operations.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("operations.emptyDescription")}</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="divide-y">
            {visible.map((operation) => (
              <li key={operation.id}>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onSelect(operation)}
                  aria-current={operation.id === selectedId ? "true" : undefined}
                  className={cn(
                    "h-auto w-full justify-start gap-2 rounded-none px-3 py-2.5 text-left whitespace-normal",
                    operation.id === selectedId && "bg-accent/50"
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {t(`operationKinds.${operation.kind}` as "operationKinds.deploy")}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <OperationStateBadge state={operation.state} />
                      <span className="truncate text-xs text-muted-foreground">
                        {operation.targetId}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {relative(operation.updatedAt)}
                    </span>
                  </span>
                  <ChevronRightIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
