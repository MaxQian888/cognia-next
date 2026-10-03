"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import { ContextDetailPanel } from "@/components/chat/context-detail-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSdkContextUsage } from "@/hooks/chat/use-sdk-context-usage"
import { buildSdkContextBreakdown } from "@/lib/claude/context-breakdown"
import { useCharacter, useSkillsByIds } from "@/lib/data-hooks/context"
import { resolveEffectiveSkills } from "@/lib/db/skills"
import { useComposerEphemeralSkillIds } from "@/stores/chat"

export interface SessionCapabilitiesSectionProps {
  session: ChatSession
  onManage?: () => void
}

/** Configuration describes the next send; only host snapshots describe loaded tools. */
export function SessionCapabilitiesSection({ session, onManage }: SessionCapabilitiesSectionProps) {
  const t = useTranslations("contextWorkbench.taskOverview.capabilities")
  const character = useCharacter(session.characterId)
  const ephemeralSkillIds = useComposerEphemeralSkillIds(session.id)
  const refs = resolveEffectiveSkills({
    characterSkillIds: character?.skillIds,
    ephemeralSkillIds,
    disabledIds: session.disabledSkillIds,
  })
  const skills = useSkillsByIds(refs.map((ref) => ref.id))
  const { snapshot, refresh } = useSdkContextUsage(session.id, session.providerOverride)
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<string[]>([])
  const breakdown = snapshot ? buildSdkContextBreakdown(snapshot) : null
  const capabilityBreakdown = breakdown
    ? {
        ...breakdown,
        free: null,
        groups: breakdown.groups.filter((group) =>
          ["systemTools", "mcp", "skills", "commands", "agents"].includes(group.id)
        ),
      }
    : null

  return (
    <section className="space-y-3" aria-label={t("title")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        {onManage ? (
          <Button variant="ghost" size="sm" onClick={onManage}>
            {t("manage")}
          </Button>
        ) : null}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("configured")}</p>
        <p className="text-xs text-muted-foreground">{t("configuredHint")}</p>
        {refs.length > 0 ? (
          <ul className="space-y-1">
            {refs.map((ref) => {
              const skill = skills?.find((item) => item.id === ref.id)
              return (
                <li key={ref.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 break-words">{skill?.name ?? ref.id}</span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {ref.inert
                      ? t("disabled")
                      : !skill
                        ? t("unresolved")
                        : ref.source === "ephemeral"
                          ? t("nextMessage")
                          : t("character")}
                  </Badge>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {session.characterId && !character ? t("unresolved") : t("noneConfigured")}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">{t("runtime")}</p>
          <Button variant="ghost" size="sm" onClick={refresh}>
            {t("refresh")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("runtimeHint")}</p>
        {capabilityBreakdown?.groups.length ? (
          <ContextDetailPanel
            breakdown={capabilityBreakdown}
            open={open}
            onOpenChange={setOpen}
            expanded={expanded}
            onExpandedChange={setExpanded}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {snapshot ? t("inventoryUnavailable") : t("snapshotUnavailable")}
          </p>
        )}
      </div>
    </section>
  )
}
