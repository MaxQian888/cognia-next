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

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CompassIcon, PlusIcon } from "lucide-react"

import { ActiveFilterChips } from "@/components/discover/active-filter-chips"
import { CategoryChipStrip } from "@/components/discover/category-chip-strip"
import { DiscoverGrid } from "@/components/discover/discover-grid"
import { DiscoverHome } from "@/components/discover/discover-home"
import { DiscoverInspector } from "@/components/discover/discover-inspector"
import { DiscoverViewToggle } from "@/components/discover/discover-view-toggle"
import { PluginMarketplaceSheet } from "@/components/discover/plugin-marketplace-sheet"
import { SkillMarketplaceSheet } from "@/components/discover/skill-marketplace-sheet"
import { SortFilterSheet } from "@/components/discover/sort-filter-sheet"
import { LongPress } from "@/components/interactions/long-press"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { CharacterCard } from "@/components/mobile/discover/character-card"
import { CharacterDetailSheet } from "@/components/mobile/discover/character-detail-sheet"
import { DiscoverCardActions } from "@/components/mobile/discover/discover-card-actions"
import { DiscoverSearch } from "@/components/mobile/discover/discover-search"
import { FeaturedCarousel } from "@/components/mobile/discover/featured-carousel"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { PluginsPanel } from "@/components/mobile/discover/plugins-panel"
import { TeamCard } from "@/components/mobile/discover/team-card"
import { SkillCard } from "@/components/mobile/discover/skill-card"
import { TwinDraftsPanel } from "@/components/mobile/discover/twin-drafts-panel"
import { TwinProfilePanel } from "@/components/mobile/discover/twin-profile-panel"
import { TwinSourcesPanel } from "@/components/mobile/discover/twin-sources-panel"
import { EmptyState } from "@/components/mobile/empty-state"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import { useDiscoverHome } from "@/hooks/discover/use-discover-home"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import { useDiscoverPreferences } from "@/hooks/discover/use-discover-preferences"
import { useDiscoverQuery, type DiscoverItem } from "@/hooks/discover/use-discover-query"
import { useDiscoverRouteState } from "@/hooks/discover/use-discover-route-state"
import { useDiscoverView } from "@/hooks/discover/use-discover-view"
import { useSearchHotkey } from "@/hooks/discover/use-search-hotkey"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { setSkillStatus } from "@/lib/db/skills"
import { runSyncDown } from "@/lib/sync/companion-sync"
import type { Character } from "@/lib/claude/types"
import {
  FAVORITES_CATEGORY,
  FORYOU_CATEGORY,
  isValidView,
  resolveLandingCategory,
  type DiscoverCategoryId,
  type DiscoverView,
} from "@/lib/discover/categories"
import { discoverViewContainer } from "@/lib/discover/view-classes"

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

/**
 * Legacy categories that benefit from the grid/list/compact density toggle.
 * Excluded by design: `plugins` (renders `PluginsPanel` + a marketplace CTA,
 * not a uniform card list) and `twinIngest` / `twinDrafts` (bespoke panels that
 * own their own item UI). On phones the `grid` mode still resolves to a single
 * column (its `sm:`+ breakpoints only widen on tablets), so the default look is
 * unchanged.
 */
const TOGGLE_LEGACY_CATEGORIES = new Set<DiscoverCategoryId>(["characters", "teams", "skills"])

export function DiscoverMobileBody() {
  const t = useTranslations("discover")
  const {
    category,
    categoryExplicit,
    item,
    sort,
    filter,
    setCategory,
    setItem,
    clearItem,
    setSort,
    setFilter,
  } = useDiscoverRouteState()
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null)
  /** Card whose long-press action sheet (share, …) is open. */
  const [actionItem, setActionItem] = useState<DiscoverItem | null>(null)

  const { favoriteKeys } = useDiscoverFavorites()
  const { layout } = useDiscoverLayout()
  const { preferences } = useDiscoverPreferences()
  const { view } = useDiscoverView()

  // Press "/" (hardware keyboard) to focus search; harmless on touch-only.
  useSearchHotkey(searchRef)

  // Land on the user's preferred category when the URL carries none, matching
  // the desktop body. Falls back to their first visible category.
  const landing = useMemo(
    () => resolveLandingCategory(preferences.landingCategory, layout),
    [preferences.landingCategory, layout]
  )
  useEffect(() => {
    if (!categoryExplicit && category !== landing) {
      setCategory(landing)
    }
  }, [categoryExplicit, category, landing, setCategory])

  const charactersQuery = useDiscoverQuery("characters", query, { sort, filter, favoriteKeys })
  const teamsQuery = useDiscoverQuery("teams", query, { sort, filter, favoriteKeys })
  const skillsQuery = useDiscoverQuery("skills", query, { sort, filter, favoriteKeys })
  const gridQuery = useDiscoverQuery(category, query, { sort, filter, favoriteKeys })
  const home = useDiscoverHome(query)

  const characters = charactersQuery.items
  const teams = teamsQuery.items
  const skills = skillsQuery.items

  const featured = charactersQuery.items
    .map((i) => (i.kind === "character" ? i.data : null))
    .filter((c): c is Character => Boolean(c?.isBuiltIn))

  const trimmed = query.trim()
  const isHome = category === FORYOU_CATEGORY
  // Favorites + the Phase-3 grid categories render through the shared grid +
  // bottom-Sheet inspector; the legacy categories own their own row UI.
  const isGridDriven =
    category === FAVORITES_CATEGORY || GRID_CATEGORIES.has(category as DiscoverCategoryId)
  // The aggregated landing selects into the same bottom-sheet inspector, backed
  // by the home hook's flat item list.
  const inspectorOpen = item !== null && (isGridDriven || isHome)
  const inspectorItems = isHome ? home.items : gridQuery.items
  // The view toggle also drives density for the three legacy card lists.
  const showToggle = isGridDriven || TOGGLE_LEGACY_CATEGORIES.has(category as DiscoverCategoryId)
  const legacyListClass = discoverViewContainer(view(category))

  // Pull-to-refresh fires the companion sync orchestrator. The downstream
  // Dexie writes flow through useLiveQuery, so no manual re-fetch is needed
  // after this call resolves. Failures are swallowed by the orchestrator
  // (per-table errors land in `lastError`) — the gesture must still feel
  // successful regardless of network state.
  const onRefresh = async () => {
    try {
      // Discover only renders the content tables below — scope the pull so it
      // doesn't also sync sessions/messages/workflows/settings the user can't
      // see from here.
      await runSyncDown({ only: ["characters", "skills", "twinProfile", "plugins"] })
    } catch {
      // Transport may be uninitialised on web/dev — fall through.
    }
  }

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background safe-area-pt safe-area-px"
      data-testid="discover-page"
    >
      <header className="flex flex-col gap-3 px-4 pt-3">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-2xl font-semibold tracking-tight">{t("title")}</h1>
          {showToggle ? <DiscoverViewToggle category={category} /> : null}
          <SortFilterSheet
            sort={sort}
            filter={filter}
            onSortChange={setSort}
            onFilterChange={setFilter}
          />
        </div>
        <DiscoverSearch value={query} onChange={setQuery} inputRef={searchRef} />
        <ActiveFilterChips
          sort={sort}
          filter={filter}
          onSortChange={setSort}
          onFilterChange={setFilter}
        />
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
        <div className="@container/discover-grid flex flex-1 flex-col overflow-y-auto px-4 pb-[calc(6rem+env(safe-area-inset-bottom))]">
          {isHome ? (
            <DiscoverHome
              home={home}
              query={query}
              selectedItemId={item}
              onSelectItem={(id) => setItem(id)}
              onSelectCategory={(id) => setCategory(id)}
            />
          ) : null}

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
              {charactersQuery.loading ? (
                <ListSkeleton />
              ) : characters.length === 0 ? (
                <EmptyState
                  icon={CompassIcon}
                  title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptyCharacters")}
                  description={trimmed.length > 0 ? undefined : t("emptyCharactersHint")}
                />
              ) : (
                <ul className={legacyListClass}>
                  {characters.map((it) => {
                    const c = it.kind === "character" ? it.data : null
                    if (!c) return null
                    return (
                      <li key={c.id}>
                        <LongPress onLongPress={() => setActionItem(it)} className="block">
                          <CharacterCard
                            character={c}
                            onSelect={(picked) => {
                              setEditingCharacter(picked)
                              setEditorOpen(true)
                            }}
                          />
                        </LongPress>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          ) : null}

          {category === "teams" ? (
            teamsQuery.loading ? (
              <ListSkeleton />
            ) : teams.length === 0 ? (
              <EmptyState
                icon={CompassIcon}
                title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptyTeams")}
                description={trimmed.length > 0 ? undefined : t("emptyTeamsHint")}
              />
            ) : (
              <ul className={legacyListClass}>
                {teams.map((it) => {
                  const tm = it.kind === "team" ? it.data : null
                  if (!tm) return null
                  return (
                    <li key={tm.id}>
                      <LongPress onLongPress={() => setActionItem(it)} className="block">
                        <TeamCard team={tm} />
                      </LongPress>
                    </li>
                  )
                })}
              </ul>
            )
          ) : null}

          {category === "skills" ? (
            <div className="flex flex-col gap-3">
              {skillsQuery.loading ? (
                <ListSkeleton />
              ) : skills.length === 0 ? (
                <EmptyState
                  icon={CompassIcon}
                  title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptySkills")}
                  description={trimmed.length > 0 ? undefined : t("emptySkillsHint")}
                />
              ) : (
                <ul className={legacyListClass}>
                  {skills.map((it) => {
                    const s = it.kind === "skill" ? it.data : null
                    if (!s) return null
                    return (
                      <li key={s.id}>
                        <LongPress onLongPress={() => setActionItem(it)} className="block">
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
                        </LongPress>
                      </li>
                    )
                  })}
                </ul>
              )}
              <SkillMarketplaceSheet className="self-start" />
            </div>
          ) : null}

          {category === "plugins" ? (
            <div className="flex flex-col gap-3">
              <PluginsPanel />
              <PluginMarketplaceSheet installedIds={new Set()} className="self-start" />
            </div>
          ) : null}

          {category === "twinIngest" ? (
            <div className="flex flex-col gap-3">
              <TwinProfilePanel twinId="default" />
              <TwinSourcesPanel />
            </div>
          ) : null}

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

      {/* Long-press action sheet for legacy cards (characters / teams / skills):
          surfaces the desktop-parity "Share via link" flow on mobile. */}
      <DiscoverCardActions
        item={actionItem}
        onOpenChange={(open) => {
          if (!open) setActionItem(null)
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
            items={inspectorItems}
            onClose={clearItem}
          />
        </SheetContent>
      </Sheet>
    </main>
  )
}
