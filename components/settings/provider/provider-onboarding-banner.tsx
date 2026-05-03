"use client"

import { X, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useSettingsStore } from "@/stores"

const QUICK_SETUP_PROVIDERS = ["openai", "anthropic", "google"] as const

interface ProviderOnboardingBannerProps {
  onScrollToProvider?: (providerId: string) => void
}

export function ProviderOnboardingBanner({ onScrollToProvider }: ProviderOnboardingBannerProps) {
  const t = useTranslations("providers")
  const dismissed = useSettingsStore((s) => s.providerOnboardingDismissed)
  const dismiss = useSettingsStore((s) => s.dismissProviderOnboarding)

  if (dismissed) return null

  return (
    <div className="relative flex items-center gap-4 rounded-lg border border-dashed bg-muted/30 px-4 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Sparkles className="h-4.5 w-4.5 text-primary" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{t("onboardingTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("onboardingDescription")}</p>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-xs text-muted-foreground">{t("onboardingQuickSetup")}:</span>
          {QUICK_SETUP_PROVIDERS.map((id) => (
            <Badge
              key={id}
              variant="outline"
              className="cursor-pointer text-xs hover:bg-primary/10 transition-colors"
              onClick={() => {
                const el = document.getElementById(`provider-${id}`)
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" })
                  el.classList.add("ring-2", "ring-primary", "ring-offset-2")
                  setTimeout(
                    () => el.classList.remove("ring-2", "ring-primary", "ring-offset-2"),
                    2000
                  )
                }
                onScrollToProvider?.(id)
              }}
            >
              {t(id)}
            </Badge>
          ))}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-6 w-6 shrink-0"
        onClick={() => void dismiss()}
      >
        <X className="h-3.5 w-3.5" />
        <span className="sr-only">{t("dismissOnboarding")}</span>
      </Button>
    </div>
  )
}
