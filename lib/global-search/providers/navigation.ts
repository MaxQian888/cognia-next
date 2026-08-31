/**
 * Pages (ADR-0129): every destination the navigation rail can reach — the
 * customisable catalog, hidden entries included — plus the two guild views
 * (Chats, Canvas). Labels come from the rail's own i18n tree so a
 * page renamed there is renamed here.
 */

import { MessagesSquareIcon, PencilRulerIcon } from "lucide-react"

import { getSidebarCatalog, type SidebarCatalogItem } from "@/lib/shell/sidebar-nav"
import { matchTitles } from "./helpers"
import type { GlobalSearchContext, GlobalSearchItem, GlobalSearchProvider } from "../types"

export const NAVIGATION_PROVIDER_ID = "builtin.navigation"

interface NavCandidate {
  id: string
  title: string
  route: string
  keywords: string[]
  icon: GlobalSearchItem["icon"]
  action: GlobalSearchItem["action"]
}

/** The rail catalog for this platform + the two guild views, resolved to labels. */
export function navigationCandidates(ctx: GlobalSearchContext): NavCandidate[] {
  const guilds: NavCandidate[] = [
    {
      id: "guild:dm",
      title: ctx.t("desktop.guildRail.directMessages"),
      route: "/",
      keywords: ["dm", "direct", "messages", "chats", "home"],
      icon: { lucide: MessagesSquareIcon },
      action: { type: "switch-guild", kind: "dm" },
    },
    {
      id: "guild:canvas",
      title: ctx.t("desktop.guildRail.canvas"),
      route: "/",
      keywords: ["canvas", "draw", "board"],
      icon: { lucide: PencilRulerIcon },
      action: { type: "switch-guild", kind: "canvas" },
    },
  ]
  // The snapshot is what tells the catalog which `standalone: "hidden"`
  // surfaces this client can actually reach. Calling without it, as this did,
  // drops all of them unconditionally, so a paired phone could not find
  // `/source-control` here even though its host serves it.
  const pages = getSidebarCatalog(ctx.platform, ctx.runtimeSnapshot).map(
    (item: SidebarCatalogItem): NavCandidate => ({
      id: `page:${item.id}`,
      title: ctx.t(`desktop.guildRail.${item.i18nKey}`),
      route: item.route,
      // `aliasKey` carries a localized, comma-separated alias list — the retired
      // name of a surface this one absorbed. Without it, a page that swallowed
      // another simply stops answering to the old name.
      keywords: [item.id, item.route, item.group, ...aliasesFor(ctx, item.aliasKey)],
      icon: { lucide: item.Icon },
      action: { type: "navigate", href: item.route },
    })
  )
  return [...guilds, ...pages]
}

/** Split the localized alias string into search terms. */
function aliasesFor(ctx: GlobalSearchContext, aliasKey: string | undefined): string[] {
  if (!aliasKey) return []
  const raw = ctx.t(`desktop.guildRail.aliases.${aliasKey}`)
  return raw
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function toItem(
  candidate: NavCandidate,
  score: number,
  positions: readonly number[] = []
): GlobalSearchItem {
  return {
    id: `navigation:${candidate.id}`,
    kind: "navigation",
    title: candidate.title,
    titlePositions: positions,
    meta: candidate.route,
    icon: candidate.icon,
    keywords: candidate.keywords,
    score,
    action: candidate.action,
  }
}

export const navigationProvider: GlobalSearchProvider = {
  id: NAVIGATION_PROVIDER_ID,
  kind: "navigation",
  search({ query, ctx, limit }) {
    const { hits, total, truncated } = matchTitles(navigationCandidates(ctx), query.needle, {
      getTitle: (c) => c.title,
      getKeywords: (c) => c.keywords,
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => toItem(row, match.score, match.positions)),
      total,
      truncated,
    }
  },
  suggest({ ctx, limit }) {
    return navigationCandidates(ctx)
      .slice(0, limit)
      .map((c, index) => toItem(c, 1 - index / (limit + 1)))
  },
}
