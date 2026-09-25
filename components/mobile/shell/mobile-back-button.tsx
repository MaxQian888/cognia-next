"use client"

/**
 * Back affordance for a phone screen that was pushed from a hub.
 *
 * Extracted from `SubPageShell` so the screens the `/me` hub opens outside
 * `/me/*` (Memory, Issues, Projects, Cycles) get the same arrow instead of a
 * bare title. Without it the only way back was the tab bar, and the tab bar
 * used to light Chat on those routes.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Whether stepping back stays inside the app.
 *
 * `history.length > 1` also counts entries from other origins, so a screen
 * opened from another site, an IM deep link or a fresh tab's `about:blank`
 * sent the in-app arrow out of the app. The Navigation API's `canGoBack` only
 * counts this origin's entries, which is the question actually being asked.
 * Engines without it (older WebKit) keep the length heuristic.
 */
export function canPopWithinApp(win: Window = window): boolean {
  const navigation = (win as Window & { navigation?: { canGoBack?: unknown } }).navigation
  if (navigation && typeof navigation.canGoBack === "boolean") return navigation.canGoBack
  return win.history.length > 1
}

/**
 * Pop history instead of pushing another entry: `hub → screen → back-arrow`
 * used to grow history to `hub, screen, hub`, so the hardware back button then
 * returned the user to the screen they had just left. Falls back to a
 * `replace()` when there is nothing in-app to pop (a cold start straight onto
 * the screen, or a deep link).
 */
export function useMobileBack(fallbackHref: string): () => void {
  const router = useRouter()
  return useCallback(() => {
    if (typeof window !== "undefined" && canPopWithinApp(window)) {
      router.back()
    } else {
      router.replace(fallbackHref)
    }
  }, [router, fallbackHref])
}

export interface MobileBackButtonProps {
  /** Where back lands when there is no history to pop. Defaults to `/me`. */
  fallbackHref?: string
  /** Accessible label. Defaults to `mobile.shell.back`. */
  label?: string
  className?: string
  testId?: string
}

export function MobileBackButton({
  fallbackHref = "/me",
  label,
  className,
  testId = "mobile-back-button",
}: MobileBackButtonProps) {
  const t = useTranslations("mobile.shell")
  const onBack = useMobileBack(fallbackHref)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label ?? t("back")}
      onClick={onBack}
      className={cn("-ml-2 shrink-0", className)}
      data-testid={testId}
    >
      <ArrowLeftIcon className="size-5" aria-hidden="true" />
    </Button>
  )
}
