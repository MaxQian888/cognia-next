"use client"

// Per-message "use web search" toggle in the composer's bottom toolbar.
// When enabled, the composer's submit handler runs the user's prompt through
// the configured search provider before forwarding to the SDK, then injects
// the formatted results as a prefix block in the outgoing message.

import { useTranslations } from "next-intl"
import { GlobeIcon } from "lucide-react"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import {
  SEARCH_PROVIDERS,
  isProviderConfigured,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
} from "@cognia/web-search/types"
import { cn } from "@/lib/utils"
import { useComposerSessionId } from "./composer-session-context"

interface WebSearchToggleProps {
  /** Disable the toggle externally (e.g. while a turn is streaming). */
  disabled?: boolean
}

export function WebSearchToggle({ disabled: streamingDisabled }: WebSearchToggleProps = {}) {
  const t = useTranslations("webSearchToggle")
  const tComposer = useTranslations("chat.composer")

  const on = useChatStore((s) => s.webSearchOnForNextSend)
  const setOn = useChatStore((s) => s.setWebSearchOnForNextSend)
  const composerSessionId = useComposerSessionId()

  const settings = useSettingsStore((s) => s.settings)
  const searchEnabled = settings?.searchEnabled ?? false
  const providers = settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  const defaultProvider = settings?.defaultSearchProvider ?? "tavily"

  const enabledProviders = Object.values(providers).filter(
    (p) => p.enabled && isProviderConfigured(p.providerId, p)
  )
  const hasEnabledProvider = enabledProviders.length > 0
  const disabled = streamingDisabled || !searchEnabled || !hasEnabledProvider

  const activeProvider = providers[defaultProvider]?.enabled
    ? defaultProvider
    : (enabledProviders[0]?.providerId ?? defaultProvider)

  const tooltip = disabled
    ? t("tooltipDisabled")
    : on
      ? t("tooltipOn", { provider: SEARCH_PROVIDERS[activeProvider]?.name ?? activeProvider })
      : t("tooltipOff")

  return (
    <TooltipIconButton
      type="button"
      size="sm"
      variant={on ? "default" : "ghost"}
      tooltip={tooltip}
      side="top"
      aria-label={tComposer("ariaToggleWebSearch")}
      aria-pressed={on}
      disabled={disabled}
      onClick={() => setOn(!on, composerSessionId)}
      className={cn(
        "h-6 gap-1 px-1.5 text-[11px] font-normal",
        on && "bg-primary/90 text-primary-foreground hover:bg-primary"
      )}
    >
      <GlobeIcon className="size-3.5" />
      <span className="hidden sm:inline">{tComposer("webLabel")}</span>
    </TooltipIconButton>
  )
}
