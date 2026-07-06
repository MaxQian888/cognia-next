"use client"

/**
 * ProviderEmptyState - Empty state component for when no providers are configured
 * Matches the design spec with centered layout and action buttons
 */

import { Cpu, Plus, Upload } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { ReactNode } from "react"

interface ProviderGuidanceItem {
  id: string
  label: string
  description?: string
  actionLabel: string
  onAction: () => void
}

interface ProviderEmptyStateProps {
  onAddProvider: () => void
  /** Omit when there's no import feature to offer — the button is hidden
   *  entirely rather than wired to a no-op. */
  onImportSettings?: () => void
  importButton?: ReactNode
  guidanceItems?: ProviderGuidanceItem[]
}

export function ProviderEmptyState({
  onAddProvider,
  onImportSettings,
  importButton,
  guidanceItems = [],
}: ProviderEmptyStateProps) {
  const t = useTranslations("providers")

  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center py-16 px-4">
        {/* Icon */}
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted mb-6">
          <Cpu className="h-8 w-8 text-muted-foreground" />
        </div>

        {/* Title */}
        <h3 className="text-lg font-semibold text-foreground mb-2">
          {t("emptyStateTitle") || "No AI Providers Configured"}
        </h3>

        {/* Description */}
        <p className="text-sm text-muted-foreground text-center max-w-md mb-6">
          {t("emptyStateDescription") ||
            "Add your first AI provider to start chatting with language models. You can configure OpenAI, Anthropic, Google, and more."}
        </p>

        {guidanceItems.length > 0 && (
          <div className="w-full max-w-2xl mb-6 space-y-2">
            {guidanceItems.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 rounded-md border bg-muted/20 px-3 py-2 text-left sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{item.label}</p>
                  {item.description && (
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  )}
                </div>
                <Button size="sm" variant="outline" onClick={item.onAction} className="shrink-0">
                  {item.actionLabel}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center gap-3">
          <Button onClick={onAddProvider} className="gap-2">
            <Plus className="h-4 w-4" />
            {t("addProvider") || "Add Provider"}
          </Button>
          {importButton ??
            (onImportSettings && (
              <Button variant="outline" onClick={onImportSettings} className="gap-2">
                <Upload className="h-4 w-4" />
                {t("importSettings") || "Import Settings"}
              </Button>
            ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default ProviderEmptyState
