/**
 * Pi packages in ⌘K (ADR-0129 + ADR-0119).
 *
 * Searches the curated catalog, not the npm registry: pi.dev/packages is an
 * npm-keyword gallery with no JSON API, and npm itself can only report versions
 * and download counts — never the overlap group, context cost or risk notes that
 * make a row here worth showing. So this provider is offline and instant.
 *
 * **It does not install anything.** Choosing a row emits an `install` action,
 * which lands on the Agent Packages section with the spec pre-selected so the
 * normal pre-install gate opens — the same dialog that shows the exact command,
 * the budget delta and any overlap. A palette that skipped that gate would be a
 * one-keystroke path to installing a package that collides with what you have,
 * which is precisely the failure Pi gives no warning about.
 *
 * Desktop-only, matching the section it routes to: Pi's package system needs a
 * config file and a CLI, neither of which exists in the browser or on mobile.
 */

import { PackageIcon } from "lucide-react"

import { PI_PACKAGE_CATALOG, type PiCatalogEntry } from "@/lib/pi-packages/catalog"
import { isTauri } from "@/lib/tauri"
import type { GlobalSearchItem } from "../types"
import { createListProvider } from "./list-provider"

export const PI_PACKAGES_PROVIDER_ID = "builtin.pi-packages"

/** Short display name: drop the `npm:` prefix and the pin, keep the scope. */
function shortName(spec: string): string {
  const withoutPrefix = spec.replace(/^npm:/, "")
  const at = withoutPrefix.lastIndexOf("@")
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix
}

export interface PiPackagesProviderDeps {
  /** Overridden in tests; the real gate is the desktop shell. */
  isDesktop: () => boolean
  listCatalog: () => readonly PiCatalogEntry[]
}

export function createPiPackagesProvider(deps: Partial<PiPackagesProviderDeps> = {}) {
  const isDesktop = deps.isDesktop ?? isTauri
  const listCatalog = deps.listCatalog ?? (() => PI_PACKAGE_CATALOG)

  return createListProvider<PiCatalogEntry>({
    id: PI_PACKAGES_PROVIDER_ID,
    kind: "pi-package",
    // Cheap and synchronous — a frozen array, so caching would only add a TTL
    // that could serve a stale catalog after a hot reload.
    cache: false,
    load: () => (isDesktop() ? listCatalog() : []),
    getTitle: (entry) => shortName(entry.spec),
    getKeywords: (entry) => [entry.id, entry.spec, entry.tier, ...entry.overlapGroups],
    toItem: ({ row, match }, ctx): GlobalSearchItem => ({
      id: `pi-package:${row.id}`,
      kind: "pi-package",
      title: shortName(row.spec),
      titlePositions: match.positions,
      subtitle: ctx.t(`plugins.agentPackages.catalog.${row.id}.summary`),
      // Surface the cost in the row: it is the fact a user most needs before
      // hitting Enter, and the one no registry would ever tell them.
      meta:
        row.tier === "avoid"
          ? ctx.t("globalSearch.piPackages.avoid")
          : row.toolCount > 0
            ? ctx.t("globalSearch.piPackages.cost", {
                tools: row.toolCount,
                tokens: row.staticTokens,
              })
            : ctx.t("globalSearch.piPackages.free"),
      icon: { lucide: PackageIcon },
      score: match.score,
      extra:
        row.tier === "avoid"
          ? { disabledReason: ctx.t("globalSearch.piPackages.avoid") }
          : undefined,
      action: { type: "install", target: "pi-package", spec: row.spec },
    }),
    // Empty-query suggestions are the core tier only. Offering the avoid rows
    // unprompted would be recommending them.
    suggest: (rows, ctx, limit) =>
      rows
        .filter((row) => row.tier === "core")
        .slice(0, limit)
        .map((row, index) => ({
          id: `pi-package:${row.id}`,
          kind: "pi-package" as const,
          title: shortName(row.spec),
          subtitle: ctx.t(`plugins.agentPackages.catalog.${row.id}.summary`),
          icon: { lucide: PackageIcon },
          score: 1 - index / (limit + 1),
          action: { type: "install" as const, target: "pi-package" as const, spec: row.spec },
        })),
  })
}

export const piPackagesProvider = createPiPackagesProvider()
