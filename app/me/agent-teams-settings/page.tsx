"use client"

/**
 * Mobile Agent Teams page (ADR-0056, decision D6 — desktop-bound section,
 * read-only on mobile). Agent teams are a desktop-collaboration runtime: teams,
 * teammates, tasks and shared memory live in the ephemeral agent-team store and
 * are *executed* by the paired desktop. The standalone (BYOK) in-webview engine
 * runs no agent loop, so this is a `<PairedOnly>` read view: it lists the
 * reusable team templates the paired desktop can launch (built-in templates are
 * seeded into the store from `BUILT_IN_TEAM_TEMPLATES`), with creation and live
 * collaboration pointed at the desktop app.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { MonitorSmartphoneIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

function AgentTeamsBody() {
  const t = useTranslations("mobile.agentTeamsSettings")
  const templates = useAgentTeamStore((s) => s.templates)

  const list = useMemo(
    () => Object.values(templates).sort((a, b) => a.name.localeCompare(b.name)),
    [templates]
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="agent-teams-intro">
        {t("intro")}
      </p>

      <MeSection
        title={t("section.title")}
        description={t("section.description")}
        testid="me-section-agent-teams"
      >
        {list.length === 0 ? (
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemDescription>{t("empty")}</ItemDescription>
            </ItemContent>
          </Item>
        ) : (
          list.map((tpl: AgentTeamTemplate) => (
            <Item key={tpl.id} size="sm" className="px-0" data-testid={`agent-team-row-${tpl.id}`}>
              <ItemContent>
                <ItemTitle className="flex items-center gap-2 text-sm">
                  <span className="truncate">{tpl.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {t(`categories.${tpl.category}`)}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {t("teammates", { count: tpl.teammates.length })}
                  </Badge>
                </ItemTitle>
                {tpl.description ? (
                  <ItemDescription className="line-clamp-2">{tpl.description}</ItemDescription>
                ) : null}
              </ItemContent>
            </Item>
          ))
        )}
      </MeSection>

      <div
        className="flex items-start gap-3 rounded-xl border bg-card px-3 py-3 text-xs text-muted-foreground"
        data-testid="agent-teams-manage-note"
      >
        <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t("manageOnDesktop")}</p>
      </div>
    </div>
  )
}

export default function MobileAgentTeamsSettingsPage() {
  const t = useTranslations("mobile.agentTeamsSettings")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-agent-teams-page">
      <PairedOnly>
        <AgentTeamsBody />
      </PairedOnly>
    </SubPageShell>
  )
}
