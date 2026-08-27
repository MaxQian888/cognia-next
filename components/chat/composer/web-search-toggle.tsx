"use client"

// Per-message "use web search" toggle in the composer's bottom toolbar.
// When enabled, the composer's submit handler runs the user's prompt through
// the configured search provider before forwarding to the SDK, then injects
// the formatted results as a prefix block in the outgoing message.

import { useTranslations } from "next-intl"
import { GlobeIcon } from "lucide-react"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useChatStore, useComposerWebSearchOn } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { SEARCH_PROVIDERS, type SearchProviderType } from "@cognia/web-search/types"
import { resolveWebAccess } from "@/lib/chat/web-access"
import { cn } from "@/lib/utils"
import { useComposerSessionId } from "./composer-session-context"

interface WebSearchToggleProps {
  /** Disable the toggle externally (e.g. while a turn is streaming). */
  disabled?: boolean
}

export function WebSearchToggle({ disabled: streamingDisabled }: WebSearchToggleProps = {}) {
  const t = useTranslations("webSearchToggle")
  const tComposer = useTranslations("chat.composer")

  const composerSessionId = useComposerSessionId()
  // This pane's conversation, matching the `setOn` write below.
  const on = useComposerWebSearchOn(composerSessionId)
  const setOn = useChatStore((s) => s.setWebSearchOnForNextSend)

  const settings = useSettingsStore((s) => s.settings)

  // One resolution, shared with the turn builder (`lib/claude/build-options.ts`).
  // This control used to re-derive "is a provider configured" from
  // `settings.searchProviders` by hand, which is the duplication
  // `lib/chat/web-access.ts` exists to remove — and it drifted: with
  // `webTools.enabled === false` every agent-facing web tool was withheld while
  // this globe stayed lit. `preSearch` is the verdict for exactly this button
  // (it runs the search itself before sending, so a runtime native does not
  // help it), and `searchProviderId` names the provider that would actually run.
  // Not memoized: `resolveWebAccess` is a pure function over plain settings
  // data and this component only re-renders when that data changes. A manual
  // `useMemo` here just fights the React Compiler, which infers `settings` as
  // the dependency where a hand-written list names its four fields.
  const webAccess = resolveWebAccess({
    ...(settings?.webTools ? { webTools: settings.webTools } : {}),
    // This button never routes through a runtime native — it pre-searches in
    // the renderer — so the native question does not enter here.
    nativeAvailable: false,
    ...(settings?.searchProviders ? { searchProviders: settings.searchProviders } : {}),
    ...(settings?.defaultSearchProvider
      ? { defaultSearchProvider: settings.defaultSearchProvider }
      : {}),
    ...(settings?.searchEnabled !== undefined ? { searchEnabled: settings.searchEnabled } : {}),
  })

  const disabled = streamingDisabled || !webAccess.preSearch
  // `searchProviderId` is carried as a plain string (the resolver is provider
  // agnostic); every value it can produce came out of `searchProviders`, so it
  // is a `SearchProviderType` in practice and the lookup below tolerates a miss.
  const activeProvider = (webAccess.searchProviderId ??
    settings?.defaultSearchProvider ??
    "tavily") as SearchProviderType

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
