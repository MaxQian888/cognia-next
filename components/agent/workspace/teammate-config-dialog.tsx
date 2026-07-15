"use client"

/**
 * Teammate config editor dialog.
 *
 * Thin wrapper that hosts `<PresetEditor>` for the shared Identity /
 * Capability / Tools / Advanced sections, then injects the 5 new agent-team
 * extra sections via `extraSections`. Persists results back to the Zustand
 * store via `updateTeammate` + `updateTeammateCapabilities`.
 *
 * Source-of-truth split (per [[feedback_reuse_existing_components]]):
 *   - All shared fields flow through `<PresetEditor>` — zero duplication
 *     with the prompt-presets section.
 *   - `teammateToPresetState` + `presetStateToTeammateConfig` are the only
 *     domain glue.
 *   - Roster fields not covered by the preset editor (role / runtime /
 *     specialization / temperature) render inline inside `extraSections`.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { PresetEditor } from "@/components/settings/presets/preset-editor"
import { NativeToolsSection } from "@/components/settings/presets/editor-sections/native-tools-section"
import { CharacterSection } from "@/components/settings/presets/editor-sections/character-section"
import { SubagentSection } from "@/components/settings/presets/editor-sections/subagent-section"
import { ExternalPresetSection } from "@/components/settings/presets/editor-sections/external-preset-section"
import { TeamCapabilityOverlaySection } from "@/components/settings/presets/editor-sections/team-capability-overlay-section"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listTwins } from "@/lib/db/twins"
import {
  presetStateToTeammateConfig,
  teammateToPresetState,
} from "@/lib/ai/agent/team/teammate-preset-adapter"
import type { ProviderName } from "@cognia/provider-types/provider"
import type { AgentTeam, AgentTeammate, TeammateRuntime } from "@/types/agent/agent-team"
import { getProviderDisplayName } from "@/lib/ai/icons"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useSettingsStore } from "@/stores/settings"
import { RUNTIME_OPTIONS, runtimeLabelKey } from "./runtime-options"

export interface TeammateConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teammate: AgentTeammate
  team: AgentTeam
}

/**
 * Sentinel for the "inherit the app default provider" option (Radix reserves
 * the empty string).
 */
const PROVIDER_DEFAULT_VALUE = "__default__"

/** Sentinel for the "no twin" Select option (Radix reserves the empty string). */
const TWIN_NONE_VALUE = "__none__"

export function TeammateConfigDialog({
  open,
  onOpenChange,
  teammate,
  team,
}: TeammateConfigDialogProps) {
  const t = useTranslations("agentTeamsWorkspace.teammateConfig")
  const tRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")

  // Provider ids the app actually has configured. Only meaningful for a lead:
  // a lead is never dispatched through a runtime, it runs its planning/review
  // turns on a resolved provider (see lib/ai/agent/team/lead-execution.ts).
  const settings = useSettingsStore((s) => s.settings)
  const providerOptions = useMemo(() => {
    const builtIn = Object.entries(settings?.providerSettings ?? {})
      .filter(([, entry]) => (entry as { enabled?: boolean } | undefined)?.enabled !== false)
      // Built-ins have catalog display names ("anthropic" → "Anthropic").
      .map(([id]) => ({ id, label: getProviderDisplayName(id) }))
    const custom = (settings?.customProviders ?? []).map((p) => ({
      id: p.id,
      // A custom provider's own name is the only label it has; the catalog
      // doesn't know it, and its id is a slug the user shouldn't have to read.
      label: p.name || p.customName || p.id,
    }))
    const seen = new Set<string>()
    return [...builtIn, ...custom].filter((p) => !seen.has(p.id) && seen.add(p.id))
  }, [settings])

  const skillsRaw = useLiveQuery(() => listSkills(), [])
  const mcpRaw = useLiveQuery(() => listMcpServers(), [])
  const twinsRaw = useLiveQuery(() => listTwins({ includeArchived: false }), [])
  const skills = useMemo(() => skillsRaw ?? [], [skillsRaw])
  const mcpServers = useMemo(() => mcpRaw ?? [], [mcpRaw])
  const twins = useMemo(() => twinsRaw ?? [], [twinsRaw])

  const updateTeammate = useAgentTeamStore((s) => s.updateTeammate)

  const initial = useMemo(() => teammateToPresetState(teammate, team), [teammate, team])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title", { name: teammate.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <PresetEditor
            initial={initial}
            skillsCatalog={skills}
            mcpCatalog={mcpServers}
            submitLabel={t("save")}
            requireContent={false}
            onCancel={() => onOpenChange(false)}
            onSave={async (output) => {
              // PresetEditorOutput maps cleanly onto PresetEditorState for
              // capability extras. Re-run the adapter to compute the
              // teammate-config patch + minimal capability overlay.
              const state = {
                ...initial,
                name: output.name,
                description: output.description ?? "",
                content: output.content,
                model: output.model ?? "",
                allowedTools: output.allowedTools ?? [],
                disallowedTools: output.disallowedTools ?? [],
                mcpServerIds: output.mcpServerIds,
                skillIds: output.skillIds ?? [],
                nativeAnthropicToolIds: output.nativeAnthropicToolIds,
                characterPackId: output.characterPackId,
                externalAgentPresetId: output.externalAgentPresetId,
                subagentIds: output.subagentIds,
              }
              const nextConfig = presetStateToTeammateConfig(state, teammate.config, team)
              updateTeammate(teammate.id, {
                name: output.name,
                description: output.description ?? teammate.description,
                config: nextConfig,
              })
              onOpenChange(false)
            }}
            extraSections={({ state, onPatch }) => (
              <>
                <SettingsCard
                  title={t("rosterSection.title")}
                  description={t("rosterSection.description")}
                >
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t("rosterSection.runtime")}</Label>
                      <Select
                        value={teammate.config.runtime ?? "claude"}
                        onValueChange={(v) => {
                          updateTeammate(teammate.id, {
                            config: {
                              ...teammate.config,
                              runtime: v as TeammateRuntime,
                            },
                          })
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RUNTIME_OPTIONS.map((r) => (
                            <SelectItem key={r} value={r}>
                              {tRuntime(runtimeLabelKey(r))}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {teammate.role === "lead" && (
                      <div className="space-y-1">
                        <Label className="text-xs">{t("rosterSection.provider")}</Label>
                        <Select
                          value={teammate.config.provider ?? PROVIDER_DEFAULT_VALUE}
                          onValueChange={(v) => {
                            updateTeammate(teammate.id, {
                              config: {
                                ...teammate.config,
                                provider:
                                  v === PROVIDER_DEFAULT_VALUE ? undefined : (v as ProviderName),
                              },
                            })
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs" data-testid="lead-provider-select">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={PROVIDER_DEFAULT_VALUE}>
                              {t("rosterSection.providerDefault")}
                            </SelectItem>
                            {providerOptions.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label className="text-xs">{t("rosterSection.specialization")}</Label>
                      <Input
                        className="h-8 text-xs"
                        defaultValue={teammate.config.specialization ?? ""}
                        onBlur={(e) => {
                          updateTeammate(teammate.id, {
                            config: {
                              ...teammate.config,
                              specialization: e.target.value.trim() || undefined,
                            },
                          })
                        }}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t("rosterSection.twin")}</Label>
                    <Select
                      value={teammate.config.twinId ?? TWIN_NONE_VALUE}
                      onValueChange={(v) => {
                        updateTeammate(teammate.id, {
                          config: {
                            ...teammate.config,
                            twinId: v === TWIN_NONE_VALUE ? undefined : v,
                          },
                        })
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={TWIN_NONE_VALUE}>
                          {t("rosterSection.twinNone")}
                        </SelectItem>
                        {twins.map((tw) => (
                          <SelectItem key={tw.id} value={tw.id}>
                            {tw.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground">
                      {t("rosterSection.twinHint")}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      {t("rosterSection.temperature", {
                        value: (teammate.config.temperature ?? 0.7).toFixed(1),
                      })}
                    </Label>
                    <Slider
                      defaultValue={[teammate.config.temperature ?? 0.7]}
                      min={0}
                      max={2}
                      step={0.1}
                      onValueCommit={([v]) =>
                        updateTeammate(teammate.id, {
                          config: { ...teammate.config, temperature: v },
                        })
                      }
                    />
                  </div>
                </SettingsCard>
                <NativeToolsSection state={state} onPatch={onPatch} />
                <CharacterSection state={state} onPatch={onPatch} />
                <SubagentSection state={state} onPatch={onPatch} />
                <ExternalPresetSection state={state} onPatch={onPatch} />
                <TeamCapabilityOverlaySection state={state} teamBundle={team.config.capabilities} />
              </>
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
