"use client"

import { ArrowRightIcon, XIcon } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/lib/onboarding/route"
import { shouldShowFinishBar } from "@/lib/onboarding/gate"
import { isShellBypassRoute } from "@/lib/shell/bypass-routes"
import { useSettingsStore } from "@/stores/settings/settings-store"

/**
 * The residual "finish setup" notice (ADR-0122, decision 13).
 *
 * Multica's equivalent is a guide *issue* seeded into the workspace the user
 * lands in. Cognia has no issue object, so the leftover lives as a thin,
 * permanently-dismissable bar — same job: a skipped step should leave something
 * behind, not vanish.
 *
 * It names what is actually missing rather than nagging generically, which is
 * only possible because `onboardingProgress.path` records *why* the user left.
 * The single `onboardingDismissedAt` timestamp it replaces could not have said
 * anything more specific than "you closed something once".
 *
 * Two paths never show it: `completed` has nothing left to finish, and
 * `legacy_dismissed` is pre-dismissed by the migration so an upgrade never
 * nags about a flow the user never opted into.
 *
 * Self-hiding — it costs one selector on the normal path — so both shells can
 * mount it unconditionally as a row of their own chrome (`DesktopAppShell`
 * under the title bar, `MobileShellWrapper` beside the offline banner). It is
 * deliberately NOT mounted at the body level: the desktop shell is `h-screen`
 * inside an `overflow:hidden` body, so a bar laid out after it was clipped,
 * and on the routes that keep the document scroll the same bar landed under
 * a `min-h-[100dvh]` page and added a scrollbar to reach it.
 */
export function FinishSetupBar() {
  const t = useTranslations("onboarding.finishBar")
  const router = useRouter()
  const pathname = usePathname()
  const settings = useSettingsStore((s) => s.settings)
  const dismiss = useSettingsStore((s) => s.dismissOnboardingFinishBar)

  if (!settings || !shouldShowFinishBar(settings)) return null
  // Never render over the flow itself — the bar's whole purpose is to get the
  // user back here, and it would be pointing at the page it is sitting on.
  if (pathname?.startsWith(ONBOARDING_ROUTE)) return null
  // Chrome-free routes get no chrome. `/pair`, `/oauth` and the share target
  // are mid-task deep links owning the whole viewport — a "finish setup" CTA
  // there interrupts the task it is standing on and, on the mobile shell,
  // still paints because that wrapper only drops its tab bar. The desktop
  // shell never mounts this on a bypass route; this covers the other shells.
  if (isShellBypassRoute(pathname)) return null

  const path = settings.onboardingProgress?.path
  if (!path) return null

  return (
    <div
      className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs"
      role="status"
      data-testid="onboarding-finish-bar"
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{t(path)}</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 text-xs"
        onClick={() => router.push(ONBOARDING_ROUTE)}
        data-testid="onboarding-finish-bar-cta"
      >
        {t("cta")}
        <ArrowRightIcon className="size-3" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        onClick={() => void dismiss()}
        aria-label={t("dismiss")}
        data-testid="onboarding-finish-bar-dismiss"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  )
}
