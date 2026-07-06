"use client"

/**
 * Mobile Providers (BYOK) page — enter your own model-provider API key so the
 * standalone (BYOK) mobile app can run chat / search / documents in-webview
 * without a paired desktop. The key is stored device-local in the settings
 * store (Dexie) via `setProviderConfig`; it is deliberately NOT synced to other
 * devices (a phone's BYOK key is its own).
 *
 * Streaming works best with the official providers (Anthropic / OpenAI /
 * Google), which allow browser-origin requests — see `lib/runtime/streaming-fetch`.
 *
 * Namespace is `mobile.providers`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PROVIDERS } from "@cognia/provider-types/provider"
import { useSettingsStore } from "@/stores/settings"

// Official providers that allow browser-origin streaming go first; the rest of
// the API-key cloud providers follow. Local engines are excluded (no key flow).
const RECOMMENDED = ["anthropic", "openai", "google"] as const

export default function MobileProvidersPage() {
  const t = useTranslations("mobile.providers")

  const settings = useSettingsStore((s) => s.settings)
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig)
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider)

  const options = useMemo(() => {
    const cloud = Object.values(PROVIDERS).filter((p) => p.apiKeyRequired && p.category !== "local")
    const recommended = RECOMMENDED.map((id) => cloud.find((p) => p.id === id)).filter(
      (p): p is (typeof cloud)[number] => Boolean(p)
    )
    const rest = cloud
      .filter((p) => !RECOMMENDED.includes(p.id as (typeof RECOMMENDED)[number]))
      .sort((a, b) => a.name.localeCompare(b.name))
    return [...recommended, ...rest]
  }, [])

  const [providerId, setProviderId] = useState<string>(settings?.defaultProvider || RECOMMENDED[0])
  const stored = settings?.providerSettings?.[providerId]
  const [apiKey, setApiKey] = useState<string>(stored?.apiKey ?? "")
  const [baseURL, setBaseURL] = useState<string>(stored?.baseURL ?? "")
  const [saved, setSaved] = useState(false)

  const onProviderChange = (id: string) => {
    setProviderId(id)
    const entry = settings?.providerSettings?.[id]
    setApiKey(entry?.apiKey ?? "")
    setBaseURL(entry?.baseURL ?? "")
    setSaved(false)
  }

  const isRecommended = RECOMMENDED.includes(providerId as (typeof RECOMMENDED)[number])

  const onSave = async () => {
    await setProviderConfig(providerId, {
      enabled: true,
      apiKey: apiKey.trim() || undefined,
      baseURL: baseURL.trim() || undefined,
    } as never)
    await setDefaultProvider(providerId)
    setSaved(true)
  }

  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-providers-page">
      <div className="flex flex-col gap-4">
        <MeSection
          title={t("sectionTitle")}
          description={t("sectionDescription")}
          testid="me-section-providers"
        >
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("provider")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("providerHelp")}</ItemDescription>
              <Select value={providerId} onValueChange={onProviderChange}>
                <SelectTrigger
                  data-testid="byok-provider"
                  aria-label={t("provider")}
                  className="mt-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {RECOMMENDED.includes(p.id as (typeof RECOMMENDED)[number])
                        ? ` · ${t("streamingBadge")}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemContent>
          </Item>

          <Item size="sm" className="px-0">
            <ItemContent>
              <Label htmlFor="byok-api-key" className="text-xs">
                {t("apiKey")}
              </Label>
              <ItemDescription className="text-[11px]">{t("apiKeyHelp")}</ItemDescription>
              <Input
                id="byok-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={t("apiKeyPlaceholder")}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setSaved(false)
                }}
                data-testid="byok-api-key"
                className="mt-1"
              />
            </ItemContent>
          </Item>

          <Item size="sm" className="px-0">
            <ItemContent>
              <Label htmlFor="byok-base-url" className="text-xs">
                {t("baseUrl")}
              </Label>
              <ItemDescription className="text-[11px]">
                {isRecommended ? t("baseUrlHelpOfficial") : t("baseUrlHelpCustom")}
              </ItemDescription>
              <Input
                id="byok-base-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                value={baseURL}
                placeholder={t("baseUrlPlaceholder")}
                onChange={(e) => {
                  setBaseURL(e.target.value)
                  setSaved(false)
                }}
                data-testid="byok-base-url"
                className="mt-1"
              />
            </ItemContent>
          </Item>

          <Button
            onClick={() => void onSave()}
            disabled={!apiKey.trim() && !baseURL.trim()}
            data-testid="byok-save"
            className="mt-1"
          >
            {saved ? t("savedCta") : t("saveCta")}
          </Button>
        </MeSection>
      </div>
    </SubPageShell>
  )
}
