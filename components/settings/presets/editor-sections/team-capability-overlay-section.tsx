"use client"

/**
 * Preset editor: Team-capability-overlay summary section (teammate-only).
 *
 * Rendered only by the TeammateConfigDialog wrapper — preset / custom-mode
 * paths skip it via `extraSections`. Reads the surrounding team's
 * capability default pool and shows a read-only summary side-by-side with
 * the teammate's effective list so users grok the merge semantics: which
 * ids come from the team, which the teammate added, which the teammate
 * removed.
 *
 * No editing happens here — actual edits flow through the other extra
 * sections (NativeTools / Skills / Subagents / Character / etc.). This
 * section is a pure overview surface.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { SettingsCard } from "@/components/settings/common/settings-section"
import type { TeamCapabilityBundle } from "@/types/agent/agent-team"

import type { PresetEditorState } from "../preset-editor-state"

export interface TeamCapabilityOverlaySectionProps {
  state: PresetEditorState
  /** Team-level default pool to compare the teammate's effective list against. */
  teamBundle?: TeamCapabilityBundle
  defaultOpen?: boolean
}

const KEYS: ReadonlyArray<{
  key: keyof TeamCapabilityBundle
  stateKey: "mcpServerIds" | "skillIds" | "nativeAnthropicToolIds" | "subagentIds"
  labelKey: string
}> = [
  { key: "mcpServerIds", stateKey: "mcpServerIds", labelKey: "mcpServers" },
  { key: "skillIds", stateKey: "skillIds", labelKey: "skills" },
  {
    key: "nativeAnthropicToolIds",
    stateKey: "nativeAnthropicToolIds",
    labelKey: "nativeTools",
  },
  { key: "subagentIds", stateKey: "subagentIds", labelKey: "subagents" },
]

function diff(
  base: ReadonlyArray<string> | undefined,
  effective: ReadonlyArray<string> | undefined
): { inherited: string[]; added: string[]; removed: string[] } {
  const baseSet = new Set(base ?? [])
  const effSet = new Set(effective ?? [])
  const inherited: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const id of effective ?? []) {
    if (baseSet.has(id)) inherited.push(id)
    else added.push(id)
  }
  for (const id of base ?? []) {
    if (!effSet.has(id)) removed.push(id)
  }
  return { inherited, added, removed }
}

export function TeamCapabilityOverlaySection({
  state,
  teamBundle,
  defaultOpen = true,
}: TeamCapabilityOverlaySectionProps) {
  const t = useTranslations("presets.editor.sections.teamCapabilityOverlay")

  return (
    <SettingsCard title={t("title")} description={t("description")} defaultOpen={defaultOpen}>
      <div className="space-y-3">
        {KEYS.map(({ key, stateKey, labelKey }) => {
          const base = teamBundle?.[key]
          const effectiveRaw = state[stateKey]
          const effective = Array.isArray(effectiveRaw) ? effectiveRaw : undefined
          const { inherited, added, removed } = diff(base, effective)
          if (inherited.length === 0 && added.length === 0 && removed.length === 0) {
            return null
          }
          return (
            <div key={key} className="space-y-1 rounded-md border p-2 text-xs">
              <p className="font-medium">{t(labelKey as never)}</p>
              {inherited.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  <span className="text-muted-foreground">{t("inheritedLabel")}:</span>
                  {inherited.map((id) => (
                    <Badge key={id} variant="outline" className="font-mono text-[10px]">
                      {id}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {added.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  <span className="text-muted-foreground">{t("addedLabel")}:</span>
                  {added.map((id) => (
                    <Badge key={id} variant="default" className="font-mono text-[10px]">
                      +{id}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {removed.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  <span className="text-muted-foreground">{t("removedLabel")}:</span>
                  {removed.map((id) => (
                    <Badge key={id} variant="destructive" className="font-mono text-[10px]">
                      −{id}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </SettingsCard>
  )
}
