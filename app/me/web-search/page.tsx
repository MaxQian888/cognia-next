"use client"

/**
 * Mobile Web search page — the master toggle, the preferred provider, the
 * default result count injected into search calls, and the cloud→system
 * fallback. All four fields (`searchEnabled`, `defaultSearchProvider`,
 * `searchMaxResults`, `searchFallbackEnabled`) are in the `app_settings_update`
 * allowlist (`companion_api/rpc.rs`). The preferred provider + fallback are
 * write-up only (NOT mirrored desktop→phone in `CROSS_PLATFORM_SETTING_KEYS`),
 * matching the Wave-2 `composerBehavior` precedent.
 *
 * Per-provider API keys are normally configured on the desktop (the sidecar
 * holds them in paired mode). In standalone (BYOK) mode there is no desktop, so
 * the in-renderer search reads keys from local Dexie — the
 * `SearchProviderKeyList` section is shown only then. Keys are never
 * allowlisted / enqueued (credentials stay device-local).
 *
 * Namespace is `mobile.webSearch` — `mobile.search` is already taken by the
 * command-palette search namespace.
 */

import { useTranslations } from "next-intl"

import { MeSection } from "@/components/mobile/me/me-section"
import { SearchProviderKeyList } from "@/components/mobile/me/search-provider-key-list"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { SEARCH_PROVIDERS, type SearchProviderType } from "@/lib/search/types"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useSettingsStore } from "@/stores/settings"

/** Result-count presets (clamped to the documented 1..50 range). */
const MAX_RESULT_PRESETS = [5, 10, 20, 50] as const

/** Provider ids in catalogue order (brand names render verbatim). */
const SEARCH_PROVIDER_IDS = Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]

export default function MobileWebSearchPage() {
  const t = useTranslations("mobile.webSearch")

  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsPatch()

  const searchEnabled = settings?.searchEnabled ?? false
  const searchMaxResults = settings?.searchMaxResults ?? 10
  const defaultSearchProvider = settings?.defaultSearchProvider ?? "tavily"
  const searchFallbackEnabled = settings?.searchFallbackEnabled ?? true
  const standalone = isStandaloneChatMode()

  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-web-search-page">
      <div className="flex flex-col gap-4">
        <MeSection
          title={t("sectionTitle")}
          description={t("sectionDescription")}
          testid="me-section-web-search"
        >
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("enabled")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("enabledHelp")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                checked={searchEnabled}
                onCheckedChange={(v) => void update({ searchEnabled: v })}
                data-testid="web-search-enabled"
                aria-label={t("enabled")}
              />
            </ItemActions>
          </Item>

          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("provider")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("providerHelp")}</ItemDescription>
              <Select
                value={defaultSearchProvider}
                onValueChange={(v) =>
                  void update({ defaultSearchProvider: v as SearchProviderType })
                }
                disabled={!searchEnabled}
              >
                <SelectTrigger
                  data-testid="web-search-provider"
                  aria-label={t("provider")}
                  className="mt-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEARCH_PROVIDER_IDS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {SEARCH_PROVIDERS[id].name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemContent>
          </Item>

          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("maxResults")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("maxResultsHelp")}</ItemDescription>
              <Select
                value={String(searchMaxResults)}
                onValueChange={(v) => void update({ searchMaxResults: Number(v) })}
                disabled={!searchEnabled}
              >
                <SelectTrigger
                  data-testid="web-search-max-results"
                  aria-label={t("maxResults")}
                  className="mt-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MAX_RESULT_PRESETS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {t("resultsCount", { count: n })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemContent>
          </Item>

          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("fallback")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("fallbackHelp")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                checked={searchFallbackEnabled}
                onCheckedChange={(v) => void update({ searchFallbackEnabled: v })}
                disabled={!searchEnabled}
                data-testid="web-search-fallback"
                aria-label={t("fallback")}
              />
            </ItemActions>
          </Item>
        </MeSection>

        {standalone && <SearchProviderKeyList />}
      </div>
    </SubPageShell>
  )
}
