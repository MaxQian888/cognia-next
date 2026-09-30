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
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
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

const SETTINGS_ROUTE = "/settings"

interface Props {
  /** Section id this strip is rendered inside — hidden from the list. */
  current: SettingsSectionId
  /** Curated targets to render, in display order. */
  targets: RelatedTarget[]
}

export function RelatedSectionsStrip({ current, targets }: Props) {
  const t = useTranslations("settings.relatedSections")
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const visible = targets.filter((target) => target.section !== current)
  if (visible.length === 0) return null

  const goTo = (target: RelatedTarget) => {
    // Inside the settings shell the section is a query param on `/settings`,
    // so swapping it in place is enough. The same sections are also mounted
    // as standalone phone pages (`/me/subscription`, `/me/mcp`, …) that read
    // no `?section=`: rewriting the query there changed nothing, and every
    // pill was a dead link on mobile. Off the shell, open the settings route.
    if (pathname !== SETTINGS_ROUTE) {
      const next = new URLSearchParams({ section: target.section })
      if (target.tabParam && target.tab) next.set(target.tabParam, target.tab)
      router.push(`${SETTINGS_ROUTE}?${next.toString()}`)
      return
    }
    const next = new URLSearchParams(params?.toString() ?? "")
    next.set("section", target.section)
    if (target.tabParam && target.tab) next.set(target.tabParam, target.tab)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div
      // Scrolls rather than wraps, the same contract every navigation slot in
      // `FeaturePageHeader` follows. Ten pills wrapped into three rows inside
      // a 375px screen, which spent about 110px of the first view on links to
      // OTHER sections before the reader saw a single control belonging to
      // this one. Secondary navigation does not get to outrank the page.
      className="flex items-center gap-1.5 overflow-x-auto rounded-md border bg-muted/30 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="navigation"
      aria-label={t("ariaLabel")}
      data-testid="related-sections-strip"
    >
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("title")}
      </span>
      {visible.map((target) => (
        <Button
          key={`${target.section}:${target.tab ?? ""}`}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => goTo(target)}
          className={cn(
            // `shrink-0` so the row scrolls instead of squeezing every pill
            // into an unreadable sliver, which is what a flex row does to
            // children that can give way.
            "h-6 shrink-0 rounded-pill bg-background px-2.5 text-[11px] font-normal",
            "hover:border-primary/40 hover:bg-accent focus-visible:border-primary/40 focus-visible:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          )}
          data-testid={`related-link-${target.section}${target.tab ? `-${target.tab}` : ""}`}
        >
          {t(target.labelKey)}
        </Button>
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
