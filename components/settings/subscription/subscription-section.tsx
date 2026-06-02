"use client"

// Unified Subscription settings section (ADR-0025). The outer Tabs picks the
// provider (Claude / Codex / OpenCode); each provider tab owns its own
// account list, login/add-account dialog, and (optional) preset picker. The
// encrypted import/export controls live at the section level so the user can
// back up every vault in one shot.
//
// URL params:
//   ?subTab=<provider>      — Claude (default) / Codex / OpenCode.
//   ?innerTab=<inner>       — Anthropic only: overview / account / usage / settings.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { ZapIcon } from "lucide-react"

import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { ImportExportButtons } from "./import-export-buttons"
import { ProviderTabAnthropic, type AnthropicInnerTab } from "./provider-tab-anthropic"
import { ProviderTabCodex } from "./provider-tab-codex"
import { ProviderTabOpencode } from "./provider-tab-opencode"
import type { ProviderId } from "@/types/subscription"
import { ALL_PROVIDER_IDS } from "@/types/subscription"

const SUBTAB_PARAM = "subTab"
const INNER_TAB_PARAM = "innerTab"

function isProviderId(value: string | null): value is ProviderId {
  return !!value && (ALL_PROVIDER_IDS as readonly string[]).includes(value)
}

function isAnthropicInnerTab(value: string | null): value is AnthropicInnerTab {
  return value === "overview" || value === "account" || value === "usage" || value === "settings"
}

export function SubscriptionSection() {
  const t = useTranslations("subscription")
  const tProviders = useTranslations("subscription.providers")
  const router = useRouter()
  const searchParams = useSearchParams()

  const subTabRaw = searchParams.get(SUBTAB_PARAM)
  const provider: ProviderId = isProviderId(subTabRaw) ? subTabRaw : "anthropic"

  const innerTabRaw = searchParams.get(INNER_TAB_PARAM)
  const anthropicInnerTab: AnthropicInnerTab = isAnthropicInnerTab(innerTabRaw)
    ? innerTabRaw
    : "overview"

  const setProvider = (next: ProviderId) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(SUBTAB_PARAM, next)
    // Inner tab is only meaningful for Anthropic — strip it on provider switch.
    if (next !== "anthropic") params.delete(INNER_TAB_PARAM)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  const setInnerTab = (next: AnthropicInnerTab) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(SUBTAB_PARAM, "anthropic")
    params.set(INNER_TAB_PARAM, next)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <ZapIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <RelatedSectionsStrip current="subscription" targets={CLAUDE_CODE_RELATED} />

      <Tabs
        value={provider}
        onValueChange={(v) => {
          if (isProviderId(v)) setProvider(v)
        }}
      >
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="anthropic">{tProviders("anthropic")}</TabsTrigger>
            <TabsTrigger value="codex">{tProviders("codex")}</TabsTrigger>
            <TabsTrigger value="opencode">{tProviders("opencode")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="anthropic" className="mt-4">
          <ProviderTabAnthropic innerTab={anthropicInnerTab} onInnerTabChange={setInnerTab} />
        </TabsContent>
        <TabsContent value="codex" className="mt-4">
          <ProviderTabCodex />
        </TabsContent>
        <TabsContent value="opencode" className="mt-4">
          <ProviderTabOpencode />
        </TabsContent>
      </Tabs>

      <ImportExportButtons />
    </div>
  )
}
