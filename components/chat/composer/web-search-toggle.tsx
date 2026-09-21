"use client"

// Per-message "use web search" toggle. It lives as a row in the composer's
// `+` menu (THIS TURN group). When enabled, the composer's submit handler runs
// the user's prompt through the configured search provider before forwarding
// to the SDK, then injects the formatted results as a prefix block in the
// outgoing message.
//
// When the toggle cannot run — the web-tools kill switch, the master search
// switch, or no configured provider — the row stays a switch in name only:
// clicking it opens a small card that names the blocker and offers a button
// to the settings section that can fix it (the host menu closes behind the
// jump). The jump is a choice, not a surprise — same convention as the
// external-services row, but with the "why" said first.

import { useTranslations } from "next-intl"
import { GlobeIcon } from "lucide-react"
import { useChatStore, useComposerWebSearchOn } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { SEARCH_PROVIDERS, type SearchProviderType } from "@cognia/web-search/types"
import { resolveWebAccess } from "@/lib/chat/web-access"
import type { SettingsTab } from "@/lib/slash-commands/builtin"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useComposerSessionId } from "./composer-session-context"
import { useComposerMenuClose } from "./composer-menu-context"
import { CapabilityRow } from "./capability-row"

interface WebSearchToggleProps {
  /** Disable the toggle externally (e.g. while a turn is streaming). */
  disabled?: boolean
  /**
   * Opens a settings section. Required for the unconfigured state to offer a
   * way out — without it the row has nowhere to send the user and stays
   * plainly disabled.
   */
  onOpenSettings?: (tab: SettingsTab) => void
}

export function WebSearchToggle({
  disabled: streamingDisabled,
  onOpenSettings,
}: WebSearchToggleProps = {}) {
  const t = useTranslations("webSearchToggle")
  const tComposer = useTranslations("chat.composer")

  const composerSessionId = useComposerSessionId()
  // This pane's conversation, matching the `setOn` write below.
  const on = useComposerWebSearchOn(composerSessionId)
  const setOn = useChatStore((s) => s.setWebSearchOnForNextSend)
  // The setup card's jump button goes through the host menu's close — the
  // popover/drawer stays open otherwise.
  const closeMenu = useComposerMenuClose()

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

  // Three settings states end at `preSearch === false`, each owned by a
  // different control: the web-tools capability switch (Settings → Tools),
  // the master search switch (Settings → Web search), and provider config
  // (same place). The setup card names the one that applies and links to
  // its tab.
  const webToolsOff = settings?.webTools?.enabled === false
  // `searchEnabled` defaults OFF (the resolver reads `?? false`), so anything
  // but an explicit true means the master switch is the thing to flip.
  const searchOff = settings?.searchEnabled !== true
  const unavailable = !webAccess.preSearch
  const setupKey = webToolsOff ? "setupToolsOff" : searchOff ? "setupSwitchOff" : "setupNoProvider"
  // The settings tab the setup card offers — null when the row behaves as a
  // real toggle (or has nowhere to send the user).
  const setupTab: SettingsTab | null =
    unavailable && onOpenSettings !== undefined ? (webToolsOff ? "tools" : "search") : null
  const disabled = setupTab === null && (streamingDisabled || unavailable)

  // `searchProviderId` is carried as a plain string (the resolver is provider
  // agnostic); every value it can produce came out of `searchProviders`, so it
  // is a `SearchProviderType` in practice and the lookup below tolerates a miss.
  const activeProvider = (webAccess.searchProviderId ??
    settings?.defaultSearchProvider ??
    "tavily") as SearchProviderType

  const tooltip =
    setupTab !== null
      ? t(setupKey)
      : on
        ? t("tooltipOn", { provider: SEARCH_PROVIDERS[activeProvider]?.name ?? activeProvider })
        : t("tooltipOff")

  const row = (
    <CapabilityRow
      icon={<GlobeIcon className="size-4" />}
      label={tComposer("webLabel")}
      // A row that opens the setup card is not a toggle: no checkbox role,
      // no armed dot. The chevron is the "this row opens a nested panel" cue.
      checkable={setupTab === null}
      active={setupTab === null && on}
      chevron={setupTab !== null}
      aria-label={tComposer("ariaToggleWebSearch")}
      disabled={disabled}
      // No hover on touch — the mobile sheet reads the reason off the row.
      hint={setupTab !== null ? t(setupKey) : undefined}
      // In setup state the PopoverTrigger owns the click.
      onClick={setupTab === null ? () => setOn(!on, composerSessionId) : undefined}
      tooltip={tooltip}
    />
  )
  if (setupTab === null) return row

  return (
    <Popover>
      <PopoverTrigger asChild>{row}</PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={8} className="w-64 p-3">
        <p className="text-sm text-muted-foreground">{t(setupKey)}</p>
        <Button
          type="button"
          size="sm"
          className="mt-2 w-full"
          onClick={() => {
            closeMenu()
            onOpenSettings?.(setupTab)
          }}
        >
          {t("goToSettings")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
