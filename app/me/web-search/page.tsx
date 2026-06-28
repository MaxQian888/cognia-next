"use client"

/**
 * Mobile Web search page — the master toggle plus the default result count
 * injected into search calls. Both fields (`searchEnabled`,
 * `searchMaxResults`) are in the `app_settings_update` allowlist
 * (`companion_api/rpc.rs`).
 *
 * Per-provider API keys are normally configured on the desktop (the sidecar
 * holds them in paired mode). In standalone (BYOK) mode there is no desktop, so
 * the in-renderer search reads keys from local Dexie — the
 * `SearchProviderKeyList` section is shown only then.
 *
 * Namespace is `mobile.webSearch` — `mobile.search` is already taken by the
 * command-palette search namespace.
 */

import { useTranslations } from "next-intl"

import { MeSection } from "@/components/mobile/me/me-section"
import { SearchProviderKeyList } from "@/components/mobile/me/search-provider-key-list"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppSettings } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

/** Result-count presets (clamped to the documented 1..50 range). */
const MAX_RESULT_PRESETS = [5, 10, 20, 50] as const

export default function MobileWebSearchPage() {
  const t = useTranslations("mobile.webSearch")
  const tPanel = useTranslations("mobile.settingsPanel")

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const searchEnabled = settings?.searchEnabled ?? false
  const searchMaxResults = settings?.searchMaxResults ?? 10
  const standalone = isStandaloneChatMode()

  const update = async (patch: Partial<AppSettings>) => {
    await save(patch as never)
    const keys = Object.keys(patch ?? {}).join(", ")
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: tPanel("queueLabel", { keys }),
    })
  }

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
        </MeSection>

        {standalone && <SearchProviderKeyList />}
      </div>
    </SubPageShell>
  )
}
