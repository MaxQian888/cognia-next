"use client"

// A2UI bridge tab — single switch controlling whether new sessions get the
// `mcp__a2ui-bridge__*` toolset by default. Per-character / per-mode
// overrides live in the Custom Mode editor; this tab governs the global
// default that flows into `resolveSendOptions`.

import { useTranslations } from "next-intl"

import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"

export function A2UIBridgeTab() {
  const t = useTranslations("settings.agentRuntimeSection.a2ui")
  const enabled = useSettingsStore((s) => s.settings?.a2uiDefaultEnabled ?? false)
  const save = useSettingsStore((s) => s.save)

  const handleToggle = (value: boolean) => {
    void save({ a2uiDefaultEnabled: value })
  }

  return (
    <SettingsStack>
      <SettingsBlock
        title={t("title")}
        description={t("description")}
        action={
          <Switch
            checked={Boolean(enabled)}
            onCheckedChange={handleToggle}
            aria-label={t("title")}
          />
        }
      >
        <p className="text-xs text-pretty text-muted-foreground">{t("hint")}</p>
      </SettingsBlock>
    </SettingsStack>
  )
}

export default A2UIBridgeTab
