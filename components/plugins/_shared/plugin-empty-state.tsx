"use client"

/**
 * Shared empty-state shell for every plugin surface (Marketplace browse,
 * Discover sheet, Library list, DevTools dropzone…). Wraps the shadcn
 * `Empty` primitives with i18n defaults so call sites don't have to
 * repeat the `plugins.shared.empty*` lookup.
 *
 * Pass `title` / `hint` explicitly to override the defaults; pass
 * `action` to render a CTA Button under the description.
 *
 * Renders with `role="status"` so screen readers announce empty
 * sections without spamming.
 */

import { useTranslations } from "next-intl"
import type { ReactNode } from "react"
import { InboxIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"

interface Props {
  title?: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  action?: { label: ReactNode; onClick: () => void }
  className?: string
  /** Override the data-testid so tests can pin to a specific empty surface. */
  dataTestId?: string
}

export function PluginEmptyState({
  title,
  hint,
  icon,
  action,
  className,
  dataTestId = "plugin-empty-state",
}: Props) {
  const t = useTranslations("plugins.shared")
  return (
    <Empty
      role="status"
      data-testid={dataTestId}
      className={cn("border bg-card text-card-foreground", className)}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <InboxIcon className="size-5" />}</EmptyMedia>
        <EmptyTitle>{title ?? t("emptyTitle")}</EmptyTitle>
        <EmptyDescription>{hint ?? t("emptyHint")}</EmptyDescription>
      </EmptyHeader>
      {action && (
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={action.onClick}>
            {action.label}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}
