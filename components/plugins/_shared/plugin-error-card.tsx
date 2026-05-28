"use client"

/**
 * Shared error-state card for plugin surfaces. Replaces the three
 * different inline error rendering styles found in the marketplace
 * audit (plain text + retry button, Card + Alert icon, naked
 * destructive p tag) with a single Card-wrapped layout.
 */

import { useTranslations } from "next-intl"
import type { ReactNode } from "react"
import { AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface Props {
  title?: ReactNode
  message: ReactNode
  onRetry?: () => void
  retryLabel?: ReactNode
  className?: string
  dataTestId?: string
}

export function PluginErrorCard({
  title,
  message,
  onRetry,
  retryLabel,
  className,
  dataTestId = "plugin-error-card",
}: Props) {
  const t = useTranslations("plugins.shared")
  return (
    <Card
      role="alert"
      data-testid={dataTestId}
      className={cn("p-6 flex flex-col items-center justify-center gap-3 text-center", className)}
    >
      <AlertTriangleIcon className="size-6 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium text-sm">{title ?? t("errorTitle")}</p>
        <p className="text-xs text-muted-foreground max-w-sm">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {retryLabel ?? t("retry")}
        </Button>
      )}
    </Card>
  )
}
