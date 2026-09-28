"use client"

/**
 * Agent-scoped `Character.toolSearchRuntimeOverride` editor.
 *
 * `resolveSendOptions` reads `character.toolSearchRuntimeOverride ??
 * appSettings.toolSearchRuntime` — the agent value replaces the app policy
 * wholesale — so this is inherit-or-own. Labels come from the app-level
 * `ToolSearchRuntimeCard` (`settings.agentRuntimeSection.toolSearch`); the pin
 * lists use the shared {@link ChipInput}. The card itself writes straight into
 * app settings, hence this controlled wrapper over the agent's own value.
 */

import { Surface } from "@/components/surface/surface"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import type { ToolSearchRuntimeConfig } from "@cognia/agent-config-types"
import { ChipInput } from "@/components/settings/gateway/shared/chip-input"
import { InheritSelect } from "./inherit-select"

type ToolSearchChoice = "enabled" | "disabled"

export interface ToolSearchOverrideProps {
  value: ToolSearchRuntimeConfig | undefined
  onChange: (next: ToolSearchRuntimeConfig | undefined) => void
}

export function ToolSearchOverride({ value, onChange }: ToolSearchOverrideProps) {
  const t = useTranslations("settings.characters.editor.advanced.toolSearch")
  const tCard = useTranslations("settings.agentRuntimeSection.toolSearch")

  return (
    <div className="space-y-2" data-testid="agent-override-tool-search">
      <InheritSelect<ToolSearchChoice>
        id="agent-override-tool-search"
        label={t("label")}
        description={t("description")}
        value={value === undefined ? undefined : value.enabled ? "enabled" : "disabled"}
        options={[
          { value: "enabled", label: t("enabled") },
          { value: "disabled", label: t("disabled") },
        ]}
        // Pins survive an enabled ↔ disabled flip, so turning deferral back on
        // restores the resident set the user already chose.
        onChange={(choice) =>
          onChange(choice === undefined ? undefined : { ...value, enabled: choice === "enabled" })
        }
      />
      {value?.enabled && (
        <Surface className="space-y-3 rounded-md border bg-background p-2">
          <div className="space-y-1">
            <Label className="text-xs">{tCard("serversLabel")}</Label>
            <p className="text-[10px] text-muted-foreground">{tCard("serversHelp")}</p>
            <ChipInput
              values={value.alwaysLoadServers ?? []}
              onCommit={(next) =>
                onChange({ ...value, alwaysLoadServers: next.length > 0 ? next : undefined })
              }
              placeholder={tCard("serversPlaceholder")}
              ariaLabel={tCard("serversLabel")}
              addLabel={tCard("addAria")}
              removeLabel={t("remove")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tCard("toolsLabel")}</Label>
            <p className="text-[10px] text-muted-foreground">{tCard("toolsHelp")}</p>
            <ChipInput
              values={value.alwaysLoadTools ?? []}
              onCommit={(next) =>
                onChange({ ...value, alwaysLoadTools: next.length > 0 ? next : undefined })
              }
              placeholder={tCard("toolsPlaceholder")}
              ariaLabel={tCard("toolsLabel")}
              addLabel={tCard("addAria")}
              removeLabel={t("remove")}
            />
          </div>
        </Surface>
      )}
    </div>
  )
}
