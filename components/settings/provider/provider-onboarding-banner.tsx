"use client"

// The provider page's "get started" guide, drawn as the shared guide callout
// (ADR-0193) so it reads as the same thing as the finish-setup bar and the
// Settings → Discover status block. It hides itself once the built-in agent
// can reach a model — "get started by configuring a provider" is wrong the
// moment one is configured — and, as before, once dismissed.
//
// It also hosts a *quiet* models.dev catalog refresh: the catalog already
// auto-syncs on app boot (see ModelsDevCatalogInitializer), so this is only an
// optional manual nudge — failures stay silent (no toast), and the counts /
// last-synced detail live behind the button's hover title.

import { KeyRoundIcon, Loader2, RefreshCw, SparklesIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { GuideCallout } from "@/components/guide/guide-callout"
import { useSettingsStore } from "@/stores"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"
import { useBuiltInModelAccess } from "@/hooks/onboarding/use-setup-status"

const QUICK_SETUP_PROVIDERS = ["openai", "anthropic", "google"] as const

/** How long a quick-setup target stays highlighted after the jump. */
const HIGHLIGHT_MS = 2000

interface ProviderOnboardingBannerProps {
  onScrollToProvider?: (providerId: string) => void
  /**
   * An external agent is already connected with its own credentials. "Get
   * started by configuring a provider" would then tell a user whose turns are
   * working that nothing works yet, so the copy narrows to what a provider
   * here would add: the built-in agent and direct model access.
   */
  externalRuntimeReady?: boolean
}

/**
 * Scroll a provider row into view and pulse it once. The pulse is the shared
 * `[data-guide-highlight]` treatment in `globals.css`, which the reduce-motion
 * guards collapse to a static outline.
 */
function highlightProviderRow(providerId: string) {
  const el = document.getElementById(`provider-${providerId}`)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  el.dataset.guideHighlight = "true"
  window.setTimeout(() => {
    delete el.dataset.guideHighlight
  }, HIGHLIGHT_MS)
}

export function ProviderOnboardingBanner({
  onScrollToProvider,
  externalRuntimeReady = false,
}: ProviderOnboardingBannerProps) {
  const t = useTranslations("providers")
  const dismissed = useSettingsStore((s) => s.providerOnboardingDismissed)
  const dismiss = useSettingsStore((s) => s.dismissProviderOnboarding)
  const builtInAccess = useBuiltInModelAccess()
  const { row, providerCount, modelCount, isSyncing, sync } = useModelsDevCatalog()

  if (dismissed) return null
  // Nothing left to get started with. `null` (still probing) keeps it up, so
  // a user who needs it does not see it flash in late.
  if (builtInAccess === true) return null

  const lastSynced = row?.fetchedAt
    ? new Date(row.fetchedAt).toLocaleString()
    : t("modelsDev.never")
  const sourceLabel =
    row?.source === "remote" ? t("modelsDev.sourceRemote") : t("modelsDev.sourceBundled")
  // Counts + source + last-synced stay discoverable as the button's hover title.
  const catalogSummary = row
    ? `${t("modelsDev.summary", { providers: providerCount, models: modelCount })} · ` +
      `${sourceLabel} · ${t("modelsDev.lastSynced", { time: lastSynced })}`
    : t("modelsDev.lastSynced", { time: lastSynced })

  return (
    <GuideCallout
      icon={externalRuntimeReady ? SparklesIcon : KeyRoundIcon}
      title={externalRuntimeReady ? t("externalRuntimes.bannerTitle") : t("onboardingTitle")}
      description={
        externalRuntimeReady ? t("externalRuntimes.bannerDescription") : t("onboardingDescription")
      }
      testId="provider-onboarding-guide"
      dismiss={{ onDismiss: () => void dismiss(), label: t("dismissOnboarding") }}
      actions={
        <>
          <span className="text-xs text-muted-foreground">{t("onboardingQuickSetup")}:</span>
          {QUICK_SETUP_PROVIDERS.map((id) => (
            <Badge
              key={id}
              asChild
              variant="outline"
              className="cursor-pointer bg-background text-xs transition-colors hover:bg-brand-action/10"
            >
              <button
                type="button"
                onClick={() => {
                  highlightProviderRow(id)
                  onScrollToProvider?.(id)
                }}
              >
                {t(id)}
              </button>
            </Badge>
          ))}
          {/* Quiet catalog refresh — silent on failure, detail in the title. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void sync()}
            disabled={isSyncing}
            title={catalogSummary}
            className="ml-1 h-auto gap-1 p-0 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-60"
          >
            {isSyncing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {isSyncing ? t("modelsDev.syncing") : t("modelsDev.update")}
          </Button>
        </>
      }
    />
  )
}
