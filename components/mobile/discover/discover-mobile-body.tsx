"use client"

/**
 * Mobile Discover body (Phase 5 polish).
 *
 * Phase 1 extracted this from the inline page.tsx. Phase 5 swaps the
 * cramped `grid-cols-5` TabsList for a horizontally scrolling
 * `<CategoryChipStrip />`, splits the previous `twinDrafts` tab into
 * `twinIngest` and `twinDrafts`, wires `<PullToRefresh />`, and renders
 * the new Phase 3 categories (workflow templates / MCP / connectors / OCR
 * providers) through the shared `<DiscoverGrid />` with a bottom-Sheet
 * inspector.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CompassIcon, PlusIcon } from "lucide-react"

import { CategoryChipStrip } from "@/components/discover/category-chip-strip"
import { DiscoverGrid } from "@/components/discover/discover-grid"
import { DiscoverInspector } from "@/components/discover/discover-inspector"
import { DiscoverViewToggle } from "@/components/discover/discover-view-toggle"
import { PluginMarketplaceSheet } from "@/components/discover/plugin-marketplace-sheet"
import { SortFilterSheet } from "@/components/discover/sort-filter-sheet"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { CharacterCard } from "@/components/mobile/discover/character-card"
import { CharacterDetailSheet } from "@/components/mobile/discover/character-detail-sheet"
import { DiscoverSearch } from "@/components/mobile/discover/discover-search"
import { FeaturedCarousel } from "@/components/mobile/discover/featured-carousel"
import { PluginsPanel } from "@/components/mobile/discover/plugins-panel"
import { TeamCard } from "@/components/mobile/discover/team-card"
import { SkillCard } from "@/components/mobile/discover/skill-card"
import { TwinDraftsPanel } from "@/components/mobile/discover/twin-drafts-panel"
import { TwinSourcesPanel } from "@/components/mobile/discover/twin-sources-panel"
import { EmptyState } from "@/components/mobile/empty-state"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import { useDiscoverQuery } from "@/hooks/discover/use-discover-query"
import { useDiscoverRouteState } from "@/hooks/discover/use-discover-route-state"
import { useDiscoverView } from "@/hooks/discover/use-discover-view"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { setSkillStatus } from "@/lib/db/skills"
import { runSyncDown } from "@/lib/sync/companion-sync"
import type { Character } from "@/lib/claude/types"
import {
  FAVORITES_CATEGORY,
  isValidView,
  type DiscoverCategoryId,
  type DiscoverView,
} from "@/lib/discover/categories"

/**
 * Categories whose content is rendered through the shared
 * `<DiscoverGrid />` + bottom-Sheet `<DiscoverInspector />` flow. The
 * legacy ones (characters / teams / skills / plugins) keep their
 * mobile-tuned cards + edit sheets because they predate the unified grid.
 */
const GRID_CATEGORIES = new Set<DiscoverCategoryId>([
  "mcpTools",
  "connectors",
  "ocrProviders",
  "workflowTemplates",
])

export function DiscoverMobileBody() {
  const t = useTranslations("discover")
  const { category, item, sort, filter, setCategory, setItem, clearItem, setSort, setFilter } =
    useDiscoverRouteState()
  const [query, setQuery] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null)

  const { favoriteKeys } = useDiscoverFavorites()
  const { view } = useDiscoverView()

  const charactersQuery = useDiscoverQuery("characters", query, { sort, filter, favoriteKeys })
  const teamsQuery = useDiscoverQuery("teams", query, { sort, filter, favoriteKeys })
  const skillsQuery = useDiscoverQuery("skills", query, { sort, filter, favoriteKeys })
  const gridQuery = useDiscoverQuery(category, query, { sort, filter, favoriteKeys })

  const characters = charactersQuery.items
  const teams = teamsQuery.items
  const skills = skillsQuery.items

  const featured = charactersQuery.items
    .map((i) => (i.kind === "character" ? i.data : null))
    .filter((c): c is Character => Boolean(c?.isBuiltIn))

  const trimmed = query.trim()
  // Favorites + the Phase-3 grid categories render through the shared grid +
  // bottom-Sheet inspector; the legacy categories own their own row UI.
  const isGridDriven =
    category === FAVORITES_CATEGORY || GRID_CATEGORIES.has(category as DiscoverCategoryId)
  const inspectorOpen = item !== null && isGridDriven

  // Pull-to-refresh fires the companion sync orchestrator. The downstream
  // Dexie writes flow through useLiveQuery, so no manual re-fetch is needed
  // after this call resolves. Failures are swallowed by the orchestrator
  // (per-table errors land in `lastError`) — the gesture must still feel
  // successful regardless of network state.
  const onRefresh = async () => {
    try {
      await runSyncDown()
    } catch {
      // Transport may be uninitialised on web/dev — fall through.
    }
  }

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background safe-area-pt"
      data-testid="discover-page"
    >
      <header className="flex flex-col gap-3 px-4 pt-3">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-2xl font-semibold tracking-tight">{t("title")}</h1>
          {isGridDriven ? <DiscoverViewToggle category={category} /> : null}
          <SortFilterSheet
            sort={sort}
            filter={filter}
            onSortChange={setSort}
            onFilterChange={setFilter}
          />
        </div>
        <DiscoverSearch value={query} onChange={setQuery} />
        <CategoryChipStrip
          activeCategory={category}
          onSelect={(id: DiscoverView) => {
            if (isValidView(id)) setCategory(id)
          }}
        />
      </header>

      {category === "characters" && trimmed.length === 0 ? (
        <FeaturedCarousel
          characters={featured}
          onSelect={(c) => {
            setEditingCharacter(c)
            setEditorOpen(true)
          }}
          className="pb-2"
        />
      ) : null}

      <PullToRefresh onRefresh={onRefresh} className="flex flex-1 min-h-0 flex-col">
        <div className="flex flex-1 flex-col overflow-y-auto px-4 pb-24">
          {category === "characters" ? (
            <>
              <div className="mb-3 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setEditingCharacter(null)
                    setEditorOpen(true)
                  }}
                  data-testid="character-create-fab"
                >
                  <PlusIcon className="size-4" />
                  {t("createCharacter")}
                </Button>
              </div>
              {characters.length === 0 ? (
                <EmptyState
                  icon={CompassIcon}
                  title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptyCharacters")}
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {characters.map((it) => {
                    const c = it.kind === "character" ? it.data : null
                    if (!c) return null
                    return (
                      <li key={c.id}>
                        <CharacterCard
                          character={c}
                          onSelect={(picked) => {
                            setEditingCharacter(picked)
                            setEditorOpen(true)
                          }}
                        />
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          ) : null}

          {category === "teams" ? (
            teams.length === 0 ? (
              <EmptyState
                icon={CompassIcon}
                title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptyTeams")}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {teams.map((it) => {
                  const tm = it.kind === "team" ? it.data : null
                  if (!tm) return null
                  return (
                    <li key={tm.id}>
                      <TeamCard team={tm} />
                    </li>
                  )
                })}
              </ul>
            )
          ) : null}

          {category === "skills" ? (
            skills.length === 0 ? (
              <EmptyState
                icon={CompassIcon}
                title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptySkills")}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {skills.map((it) => {
                  const s = it.kind === "skill" ? it.data : null
                  if (!s) return null
                  return (
                    <li key={s.id}>
                      <SkillCard
                        skill={s}
                        onToggle={(skill) => {
                          const nextEnabled = skill.status === "disabled"
                          void setSkillStatus(skill.id, nextEnabled ? "enabled" : "disabled")
                          void enqueue({
                            command: "skill_set_enabled",
                            payload: { id: skill.id, enabled: nextEnabled },
                            label: `${nextEnabled ? "Enable" : "Disable"} skill ${skill.name}`,
                          })
                        }}
                      />
                    </li>
                  )
                })}
              </ul>
            )
          ) : null}

          {category === "plugins" ? (
            <div className="flex flex-col gap-3">
              <PluginsPanel />
              <PluginMarketplaceSheet installedIds={new Set()} className="self-start" />
            </div>
          ) : null}

          {category === "twinIngest" ? <TwinSourcesPanel /> : null}

          {category === "twinDrafts" ? <TwinDraftsPanel /> : null}

          {isGridDriven ? (
            <DiscoverGrid
              category={category}
              items={gridQuery.items}
              loading={gridQuery.loading}
              query={query}
              view={view(category)}
              selectedItemId={item}
              onSelectItem={(id) => setItem(id)}
            />
          ) : null}
        </div>
      </PullToRefresh>

      <CharacterDetailSheet
        open={editorOpen}
        character={editingCharacter}
        onOpenChange={(next) => {
          setEditorOpen(next)
          if (!next) setEditingCharacter(null)
        }}
      />

      {/* Bottom-Sheet inspector for grid-driven categories. The legacy
          categories (characters / teams / skills / plugins / twin*) own
          their own row-level interactions and do not open this sheet. */}
      <Sheet open={inspectorOpen} onOpenChange={(open) => (open ? null : clearItem())}>
        <SheetContent side="bottom" className="max-h-[85vh] p-0">
          <DiscoverInspector
            category={category}
            itemId={item}
            items={gridQuery.items}
            onClose={clearItem}
          />
        </SheetContent>
      </Sheet>
    </main>
  )
}
