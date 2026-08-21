"use client"

// Shared `<SelectContent>` for the API-protocol dropdown. Both the
// custom-provider dialog and the per-provider config tab offer the same choice
// — the three built-in protocols (OpenAI / Anthropic / Gemini) plus any
// plugin-registered protocol adapters — so the option list and its
// descriptions live here once instead of being copy-pasted (and silently
// drifting) between the two surfaces.
//
// Option descriptions carry `data-select-desc` so a trigger can hide them:
// Radix mirrors the selected item's children into the trigger, and a two-line
// option overflows a one-line trigger. Surfaces that already print the hint
// next to the field opt out with `[&_[data-select-desc]]:hidden`.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { SelectContent, SelectItem } from "@/components/ui/select"
import { listProtocolAdapters } from "@cognia/provider-core/providers/protocol-adapter-registry"

export function ProtocolSelectContent() {
  const t = useTranslations("providers")
  const pluginProtocols = useMemo(() => listProtocolAdapters(), [])
  return (
    <SelectContent>
      <SelectItem value="openai">
        <div className="flex flex-col">
          {/* i18n-exempt: vendor brand name, identical in every locale */}
          <span>OpenAI</span>
          <span data-select-desc="" className="text-xs text-muted-foreground">
            {t("protocolOpenAIDesc")}
          </span>
        </div>
      </SelectItem>
      <SelectItem value="anthropic">
        <div className="flex flex-col">
          {/* i18n-exempt: vendor brand name, identical in every locale */}
          <span>Anthropic</span>
          <span data-select-desc="" className="text-xs text-muted-foreground">
            {t("protocolAnthropicDesc")}
          </span>
        </div>
      </SelectItem>
      <SelectItem value="gemini">
        <div className="flex flex-col">
          {/* i18n-exempt: vendor brand name, identical in every locale */}
          <span>Gemini</span>
          <span data-select-desc="" className="text-xs text-muted-foreground">
            {t("protocolGeminiDesc")}
          </span>
        </div>
      </SelectItem>
      {pluginProtocols.map((p) => (
        <SelectItem key={p.id} value={p.id}>
          <div className="flex flex-col">
            <span>{p.label}</span>
            <span data-select-desc="" className="text-xs text-muted-foreground">
              {t("protocolPluginDesc", { plugin: p.pluginId ?? "plugin" })}
            </span>
          </div>
        </SelectItem>
      ))}
    </SelectContent>
  )
}
