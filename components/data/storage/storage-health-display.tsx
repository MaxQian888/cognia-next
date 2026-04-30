"use client"

// Health badge + issues + recommendations card. Adapted from
// D:\Project\Cognia\components\settings\data\storage-health.tsx — direct copy
// minus the i18n key prefix (now `settings.data.health.*`).

import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  LightbulbIcon,
  XCircleIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { StorageHealth, StorageIssue, StorageRecommendation } from "@/lib/storage"

interface StorageHealthDisplayProps {
  health: StorageHealth | null
  formatBytes: (bytes: number) => string
  onActionClick?: (action: string) => void
  className?: string
}

export function StorageHealthDisplay({
  health,
  formatBytes,
  onActionClick,
  className,
}: StorageHealthDisplayProps) {
  const t = useTranslations("settings.data.health")
  if (!health) return null

  const statusConfig = {
    healthy: {
      icon: CheckCircle2Icon,
      color: "text-green-500",
      bgColor: "bg-green-500/10",
      label: t("healthy"),
    },
    warning: {
      icon: AlertTriangleIcon,
      color: "text-yellow-500",
      bgColor: "bg-yellow-500/10",
      label: t("warning"),
    },
    critical: {
      icon: XCircleIcon,
      color: "text-red-500",
      bgColor: "bg-red-500/10",
      label: t("critical"),
    },
  } as const

  const config = statusConfig[health.status]
  const StatusIcon = config.icon

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn("rounded-full p-1", config.bgColor)}>
            <StatusIcon className={cn("size-4", config.color)} />
          </div>
          <span className="text-sm font-medium">{config.label}</span>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {health.usagePercent.toFixed(1)}% {t("used")}
        </Badge>
      </div>

      {health.issues.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{t("issues")}</h4>
          {health.issues.map((issue, index) => (
            <IssueItem key={index} issue={issue} />
          ))}
        </div>
      )}

      {health.recommendations.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{t("recommendations")}</h4>
          {health.recommendations.map((rec, index) => (
            <RecommendationItem
              key={index}
              recommendation={rec}
              formatBytes={formatBytes}
              onActionClick={onActionClick}
            />
          ))}
        </div>
      )}

      {health.status === "healthy" && health.issues.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("allGood")}</p>
      )}
    </div>
  )
}

function IssueItem({ issue }: { issue: StorageIssue }) {
  const severityColors = {
    low: "border-blue-500/50 bg-blue-500/5",
    medium: "border-yellow-500/50 bg-yellow-500/5",
    high: "border-red-500/50 bg-red-500/5",
  } as const

  return (
    <div className={cn("rounded-md border p-2 text-xs", severityColors[issue.severity])}>
      <p className="font-medium">{issue.message}</p>
      {issue.suggestedAction && (
        <p className="mt-0.5 text-muted-foreground">{issue.suggestedAction}</p>
      )}
    </div>
  )
}

function RecommendationItem({
  recommendation,
  formatBytes,
  onActionClick,
}: {
  recommendation: StorageRecommendation
  formatBytes: (bytes: number) => string
  onActionClick?: (action: string) => void
}) {
  const t = useTranslations("settings.data.health")
  return (
    <div className="flex items-start gap-2 rounded-md border p-2 text-xs">
      <LightbulbIcon className="mt-0.5 size-3.5 shrink-0 text-yellow-500" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{recommendation.action}</p>
        <p className="text-muted-foreground">{recommendation.description}</p>
        {recommendation.estimatedSavings > 0 && (
          <p className="mt-0.5 text-green-600">
            {t("potentialSavings")}: {formatBytes(recommendation.estimatedSavings)}
          </p>
        )}
      </div>
      {onActionClick && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={() => onActionClick(recommendation.action)}
        >
          <ChevronRightIcon className="size-3" />
        </Button>
      )}
    </div>
  )
}
