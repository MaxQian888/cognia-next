"use client"

/**
 * VSCode-style back / forward navigation arrows for the desktop title bar.
 *
 * Rendered to the left of the centered command-center pill. Disabled state is
 * driven by the in-memory history in `use-nav-history` (Next's router exposes
 * no `canGoBack`). Native `title` + `aria-label` are used for the hover hint —
 * matching the existing window-control buttons, which avoid the Radix Tooltip
 * provider coupling.
 */

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { navigateBack, navigateForward, useNavHistory } from "@/hooks/desktop/use-nav-history"
import { cn } from "@/lib/utils"

function NavArrowButton({
  label,
  testId,
  disabled,
  onClick,
  children,
}: {
  label: string
  testId: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded-sm text-muted-foreground transition-[color,opacity] hover:text-foreground",
        "motion-safe:transition-transform motion-safe:active:scale-90 disabled:opacity-40"
      )}
    >
      {children}
    </Button>
  )
}

export function TitleBarNavArrows({ className }: { className?: string }) {
  const t = useTranslations("desktop.titleBar")
  const router = useRouter()
  const { canBack, canForward } = useNavHistory()

  return (
    <div className={cn("flex items-center gap-0.5", className)} data-testid="title-bar-nav-arrows">
      <NavArrowButton
        label={t("back")}
        testId="title-bar-nav-back"
        disabled={!canBack}
        onClick={() => navigateBack(router)}
      >
        <ChevronLeftIcon className="size-4" aria-hidden />
      </NavArrowButton>
      <NavArrowButton
        label={t("forward")}
        testId="title-bar-nav-forward"
        disabled={!canForward}
        onClick={() => navigateForward(router)}
      >
        <ChevronRightIcon className="size-4" aria-hidden />
      </NavArrowButton>
    </div>
  )
}
