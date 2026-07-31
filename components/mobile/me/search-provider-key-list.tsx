"use client"

/**
 * Mobile entry for the per-search-provider API keys (Exa / Tavily / Brave / …).
 *
 * In paired mode the sidecar holds these keys on the desktop, so the keys are
 * intentionally not surfaced on the phone. In standalone (BYOK) mode there is no
 * desktop: the in-renderer search (`lib/search/search-service`) reads the keys
 * straight from local Dexie via `AppSettings.searchProviders`, so the user must
 * be able to enter them here. Writes reuse the existing settings-store actions
 * (`setSearchProviderApiKey` / `setSearchProviderEnabled` /
 * `setSearchProviderSettings`) which persist to Dexie with no sidecar push — the
 * same BYOK-safe path the `/me/providers` model-key page uses.
 */

import { useState } from "react"
import { EyeIcon, EyeOffIcon, ExternalLinkIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  SEARCH_PROVIDERS,
  isProviderConfigured,
  validateApiKey,
  type SearchProviderType,
} from "@cognia/web-search/types"
import { useSettingsStore } from "@/stores/settings"

const PROVIDER_IDS = Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]

export function SearchProviderKeyList() {
  const t = useTranslations("mobile.webSearch")
  const tSearch = useTranslations("searchSettings")

  const providers = useSettingsStore((s) => s.settings?.searchProviders)
  const setSearchProviderApiKey = useSettingsStore((s) => s.setSearchProviderApiKey)
  const setSearchProviderEnabled = useSettingsStore((s) => s.setSearchProviderEnabled)
  const setSearchProviderSettings = useSettingsStore((s) => s.setSearchProviderSettings)

  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  return (
    <section className="flex flex-col gap-2" data-testid="me-section-search-keys">
      <div className="flex flex-col gap-0.5 px-1">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("providersTitle")}
        </h2>
        <p className="text-[11px] text-muted-foreground/80">{t("providersDescription")}</p>
      </div>

      <ul className="flex flex-col gap-2">
        {PROVIDER_IDS.map((id) => {
          const config = SEARCH_PROVIDERS[id]
          const settings = providers?.[id] ?? DEFAULT_SEARCH_PROVIDER_SETTINGS[id]
          const show = revealed[id] ?? false
          const hasKey = Boolean(settings.apiKey)
          const isActive = settings.enabled && isProviderConfigured(id, settings)
          const invalidKey = hasKey && !validateApiKey(id, settings.apiKey)
          const canEnable =
            id === "google" ? hasKey && Boolean(settings.cx?.trim()) : hasKey

          return (
            <li
              key={id}
              className="flex flex-col gap-2 rounded-xl border bg-card p-3"
              data-testid={`search-key-row-${id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{config.name}</span>
                <Switch
                  checked={settings.enabled}
                  disabled={!settings.enabled && !canEnable}
                  onCheckedChange={(v) => void setSearchProviderEnabled(id, v)}
                  aria-label={t("enableProviderAria", { name: config.name })}
                  data-testid={`search-key-enabled-${id}`}
                />
              </div>

              <div className="relative">
                <Input
                  type={show ? "text" : "password"}
                  value={settings.apiKey ?? ""}
                  placeholder={config.apiKeyPlaceholder}
                  onChange={(e) => void setSearchProviderApiKey(id, e.target.value)}
                  aria-label={t("providerKeyAria", { name: config.name })}
                  autoComplete="new-password"
                  data-lpignore="true"
                  className="pr-10"
                  data-testid={`search-key-input-${id}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setRevealed((r) => ({ ...r, [id]: !show }))}
                  aria-label={t("revealKeyAria", { name: config.name })}
                  data-testid={`search-key-reveal-${id}`}
                >
                  {show ? (
                    <EyeOffIcon className="size-4" aria-hidden="true" />
                  ) : (
                    <EyeIcon className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>

              {id === "google" && (
                <Input
                  type="text"
                  value={settings.cx ?? ""}
                  placeholder={tSearch("googleCxPlaceholder")}
                  onChange={(e) => void setSearchProviderSettings(id, { cx: e.target.value })}
                  aria-label={tSearch("googleCx")}
                  autoComplete="off"
                  data-testid="search-key-google-cx"
                />
              )}

              {invalidKey && (
                <p className="text-[11px] text-amber-600" data-testid={`search-key-invalid-${id}`}>
                  {tSearch("invalidKeyFormat")}
                </p>
              )}

              <div className="flex items-center justify-between">
                <a
                  href={config.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  {tSearch("getApiKey")} {config.name}
                  <ExternalLinkIcon className="size-3" aria-hidden="true" />
                </a>
                {isActive && (
                  <span className="text-[10px] font-medium text-primary">{tSearch("active")}</span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
