"use client"

/**
 * RelatedSectionsStrip — a compact "Related" pill strip surfaced at the top
 * of every Claude Code-related settings section so users can hop between
 * adjacent surfaces without bouncing through the sidebar.
 *
 * Stage 5 of the ClaudeCode 完整化 plan. The list is hand-curated rather
 * than derived from `SETTINGS_NAV` because we want the order + the "current"
 * entry hidden, both of which need per-section knowledge.
 */

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"

export interface RelatedTarget {
  /** The Settings section id (matches `?section=`). */
  section: SettingsSectionId
  /**
   * Optional sub-tab parameter for sections that own a `?<x>Tab=` slot.
   * The strip stamps it on the URL so deep-links land on a specific tab.
   */
  tabParam?: string
  /** Value for the optional sub-tab. */
  tab?: string
  /** i18n key (under `settings.relatedSections.*`). */
  labelKey: string
}

interface Props {
  /** Section id this strip is rendered inside — hidden from the list. */
  current: SettingsSectionId
  /** Curated targets to render, in display order. */
  targets: RelatedTarget[]
}

export function RelatedSectionsStrip({ current, targets }: Props) {
  const t = useTranslations("settings.relatedSections")
  const router = useRouter()
  const params = useSearchParams()

  const visible = targets.filter((target) => target.section !== current)
  if (visible.length === 0) return null

  const goTo = (target: RelatedTarget) => {
    const next = new URLSearchParams(params?.toString() ?? "")
    next.set("section", target.section)
    if (target.tabParam && target.tab) next.set(target.tabParam, target.tab)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1.5"
      role="navigation"
      aria-label={t("ariaLabel")}
      data-testid="related-sections-strip"
    >
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("title")}
      </span>
      {visible.map((target) => (
        <button
          key={`${target.section}:${target.tab ?? ""}`}
          type="button"
          onClick={() => goTo(target)}
          className={cn(
            "inline-flex h-6 items-center rounded-full border bg-background px-2.5 text-[11px] transition-colors",
            "hover:border-primary/40 hover:bg-accent focus-visible:border-primary/40 focus-visible:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          )}
          data-testid={`related-link-${target.section}${target.tab ? `-${target.tab}` : ""}`}
        >
          {t(target.labelKey)}
        </button>
      ))}
    </div>
  )
}

/**
 * Curated default targets shared by every Claude Code-related section.
 * Keeping the list in one place avoids drift between sections that all want
 * to point at "the rest of the cluster".
 */
export const CLAUDE_CODE_RELATED: RelatedTarget[] = [
  {
    section: "agent-runtime",
    tabParam: "agentRuntimeTab",
    tab: "defaults",
    labelKey: "agentRuntime",
  },
  {
    section: "agent-runtime",
    tabParam: "agentRuntimeTab",
    tab: "sessions",
    labelKey: "sessions",
  },
  { section: "subscription", labelKey: "subscription" },
  { section: "ccswitch", labelKey: "ccswitch" },
  { section: "mcp", labelKey: "mcp" },
  { section: "hooks", labelKey: "hooks" },
  { section: "fleet", labelKey: "fleet" },
  { section: "slash-commands", labelKey: "slashCommands" },
  { section: "subagents", labelKey: "subagents" },
  { section: "tools", labelKey: "tools" },
]
