"use client"

import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { resolveStringOrPath } from "@/lib/a2ui/data-model"
import type { A2UIComponentProps, A2UIWidgetStatusComponent } from "@/types/a2ui/schema"

function renderStatusIcon(status: A2UIWidgetStatusComponent["status"], className: string) {
  switch (status) {
    case "ready":
      return <CheckCircle2 className={className} />
    case "loading":
      return <Loader2 className={className} />
    case "fallback":
      return <AlertTriangle className={className} />
    case "error":
    default:
      return <AlertCircle className={className} />
  }
}

export function A2UIWidgetStatus({
  component,
  dataModel,
  onAction,
}: A2UIComponentProps<A2UIWidgetStatusComponent>) {
  const title = resolveStringOrPath(component.title ?? "", dataModel, "")
  const message = resolveStringOrPath(component.message, dataModel, "")
  const detail = resolveStringOrPath(component.detail ?? "", dataModel, "")
  const actionLabel = resolveStringOrPath(component.actionLabel ?? "", dataModel, "")
  const iconClassName = component.status === "loading" ? "h-4 w-4 animate-spin" : "h-4 w-4"

  return (
    <Alert>
      {renderStatusIcon(component.status, iconClassName)}
      <AlertDescription className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {title ? <span className="font-medium">{title}</span> : null}
          <Badge variant="outline" className="capitalize">
            {component.status}
          </Badge>
        </div>
        <p className="text-sm">{message}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        {component.action && actionLabel ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onAction(component.action!)}
          >
            {actionLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
