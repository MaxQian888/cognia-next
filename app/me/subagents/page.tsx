"use client"

/**
 * Mobile Subagents page (ADR-0056, decision D6 — desktop-bound section,
 * read-only on mobile). Subagent templates are a desktop-collaboration
 * runtime: the templates live in the ephemeral `subagent-runtime-store`
 * (persisted to localStorage, re-seeded from the built-in registry) and are
 * *executed* by the paired desktop sidecar via `dispatch_agent`. The
 * standalone (BYOK) in-webview engine runs no agent loop, so this is a
 * `<PairedOnly>` read view: it lists the available templates the paired
 * desktop can dispatch, with creation/editing pointed to the desktop app.
 *
 * Reuses the desktop `settings.subagents.templates` namespace for the shared
 * category + built-in labels so the two surfaces stay in lock-step.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"

function SubagentsBody() {
  const t = useTranslations("mobile.subagents")
  const tTpl = useTranslations("settings.subagents.templates")
  const templates = useSubagentRuntimeStore((s) => s.templates)

  const list = useMemo(
    () =>
      Object.values(templates).sort((a, b) => {
        const aBuilt = a.isBuiltIn ?? false
        const bBuilt = b.isBuiltIn ?? false
        if (aBuilt !== bBuilt) return aBuilt ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
    [templates]
  )

  return (
    <MeSection
      title={t("sectionTitle")}
      description={t("sectionDescription")}
      testid="me-section-subagents"
    >
      {list.length === 0 ? (
        <Item size="sm">
          <ItemContent>
            <ItemDescription>{t("empty")}</ItemDescription>
          </ItemContent>
        </Item>
      ) : (
        list.map((tpl: SubAgentTemplate) => (
          <Item key={tpl.id} size="sm" data-testid={`subagent-row-${tpl.id}`}>
            <ItemContent>
              <ItemTitle className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`truncate ${tpl.disabled ? "line-through opacity-60" : ""}`}>
                  {tpl.name}
                </span>
                {/* Availability mirrors the desktop switches. Without these the
                    two surfaces disagree: a template disabled on desktop is
                    excluded from dispatch, but would still read as available
                    here. */}
                {tpl.disabled ? (
                  <Badge
                    variant="outline"
                    className="text-[10px]"
                    data-testid={`disabled-${tpl.id}`}
                  >
                    {tTpl("disabledBadge")}
                  </Badge>
                ) : null}
                {tpl.hidden ? (
                  <Badge variant="outline" className="text-[10px]" data-testid={`hidden-${tpl.id}`}>
                    {tTpl("hiddenBadge")}
                  </Badge>
                ) : null}
                {tpl.isBuiltIn ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {tTpl("builtIn")}
                  </Badge>
                ) : null}
                <Badge variant="outline" className="text-[10px]">
                  {tTpl(`categories.${tpl.category}`)}
                </Badge>
                {tpl.config?.model ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {tpl.config.model}
                  </Badge>
                ) : null}
              </ItemTitle>
              {tpl.description ? (
                <ItemDescription className="line-clamp-2">{tpl.description}</ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
        ))
      )}
      <Item size="sm">
        <ItemContent>
          <ItemDescription>{t("manageHint")}</ItemDescription>
        </ItemContent>
      </Item>
    </MeSection>
  )
}

export default function MobileSubagentsPage() {
  const t = useTranslations("mobile.subagents")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-subagents-page">
      <PairedOnly>
        <SubagentsBody />
      </PairedOnly>
    </SubPageShell>
  )
}
