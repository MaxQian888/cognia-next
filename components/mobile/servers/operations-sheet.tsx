"use client"

/**
 * The operations rail, on a phone.
 *
 * On the desktop it is the right pane of `FeaturePageShell`, which below `md`
 * collapses into a 16px panel-icon trigger with no label. That is fine for a
 * decorative sidebar and wrong for this one: the rail is where a running
 * deploy reports itself, so it needs an affordance that says what it holds and
 * how many are in flight.
 *
 * The rail itself is the same component. Only the container changes.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon } from "lucide-react"

import { OperationsRail } from "@/components/servers/operations-rail"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Operation } from "@/lib/server-ops/client"
import { isTerminalOperation } from "@/lib/server-ops/operation-stream"

export interface OperationsSheetProps {
  operations: readonly Operation[]
  liveEvents: boolean
  eventStreamConnected: boolean
  onSelect: (operation: Operation) => void
  /** Set on the detail route so the rail shows only that server's work. */
  targetId?: string
}

/**
 * How many operations are still going, which is the only number worth putting
 * on the trigger. A finished deploy is history and belongs inside.
 *
 * "Still going" is `isTerminalOperation`, not a second list of states written
 * out here. There are ten of them and the rail already reads the same
 * predicate, so a new one added to the controller must not mean two places
 * disagree about whether a deploy has finished.
 */
function activeCount(operations: readonly Operation[], targetId?: string): number {
  return operations.filter(
    (operation) =>
      (!targetId || operation.targetId === targetId) && !isTerminalOperation(operation)
  ).length
}

export function MobileOperationsSheet({
  operations,
  liveEvents,
  eventStreamConnected,
  onSelect,
  targetId,
}: OperationsSheetProps) {
  const t = useTranslations("servers")
  const [open, setOpen] = useState(false)
  const active = activeCount(operations, targetId)

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5"
        onClick={() => setOpen(true)}
        data-testid="mobile-servers-operations"
      >
        <ActivityIcon className="size-3.5" />
        {t("operations.title")}
        {active > 0 ? (
          <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px] tabular-nums">
            {active}
          </Badge>
        ) : null}
      </Button>

      <ResponsiveDetailSheet
        open={open}
        onOpenChange={setOpen}
        title={t("operations.ariaLabel")}
      >
        {/*
          The drawer caps itself at 85vh and the rail is `h-full` with its own
          scroller, so a bounded box between the two gives that scroller
          something definite to resolve against.
        */}
        <div className="h-[68vh] min-h-0">
          <OperationsRail
            operations={operations}
            liveEvents={liveEvents}
            eventStreamConnected={eventStreamConnected}
            selectedId={null}
            onSelect={(operation) => {
              // Close first: the inspector is itself a sheet, and stacking one
              // over the other leaves two scrims and no way back.
              setOpen(false)
              onSelect(operation)
            }}
            targetId={targetId}
          />
        </div>
      </ResponsiveDetailSheet>
    </>
  )
}
