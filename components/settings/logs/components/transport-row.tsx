"use client"

/**
 * One transport in the Logs → Transports list: a toggle, a live health badge,
 * and a disclosure holding whatever configuration that transport needs.
 *
 * The badge is the point. The old list showed seven switches with no way to
 * tell an enabled-and-working transport from an enabled-but-misconfigured one
 * — the health data existed (`useTransportHealth`) but was rendered only as a
 * single banner about *native* logging, several hundred lines away.
 */

import type { ComponentType, ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

export interface TransportRowProps {
  id: string
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  /** Live snapshot for this transport, when the logger has registered one. */
  health?: TransportHealthSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}

const HEALTH_CLASSES: Record<TransportHealthSnapshot["status"], string> = {
  healthy: "border-success/40 bg-success/10 text-success",
  degraded: "border-warning/40 bg-warning/10 text-warning",
  offline: "border-border bg-muted text-muted-foreground",
}

export function TransportRow({
  id,
  icon: Icon,
  title,
  description,
  enabled,
  onEnabledChange,
  health,
  open,
  onOpenChange,
  children,
}: TransportRowProps) {
  const t = useTranslations("logging.settings.transports")

  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <div
        className={cn(
          "rounded-lg border transition-colors",
          enabled ? "bg-background" : "bg-muted/30"
        )}
        data-testid={`logs-transport-${id}`}
        data-enabled={enabled}
      >
        <div className="flex items-start gap-3 p-3">
          <CollapsibleTrigger
            className={cn(
              "-m-1 flex min-w-0 flex-1 items-start gap-2.5 rounded-md p-1 text-left",
              "transition-colors hover:bg-accent/40",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
            aria-label={t("toggleDetails", { transport: title })}
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                enabled ? "text-foreground" : "text-muted-foreground"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <Label htmlFor={`logs-transport-switch-${id}`} className="text-sm font-medium">
                  {title}
                </Label>
                {health ? (
                  <Badge
                    variant="outline"
                    className={cn("px-1.5 text-[10px] uppercase", HEALTH_CLASSES[health.status])}
                    data-testid={`logs-transport-health-badge-${id}`}
                  >
                    {health.status}
                  </Badge>
                ) : null}
              </span>
              <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
                {description}
              </span>
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </CollapsibleTrigger>
          <Switch
            id={`logs-transport-switch-${id}`}
            className="mt-0.5 shrink-0"
            checked={enabled}
            onCheckedChange={onEnabledChange}
          />
        </div>
        <CollapsibleContent>
          <div className="space-y-4 border-t px-3 py-3">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
