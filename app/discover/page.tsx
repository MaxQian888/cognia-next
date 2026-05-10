"use client"

/**
 * Discover tab (Wave 2.4).
 *
 * Mobile-friendly browser of characters, teams, skills, and twin drafts.
 * Exposed at `/discover`; the bottom Tab Bar links into it from the third
 * tab. On desktop the page renders too (no platform gate) so the workflows
 * /agent-teams pages aren't the only window into the catalogue.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CompassIcon, PlusIcon } from "lucide-react"

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { listCharacters } from "@/lib/db/characters"
import { listSkills, setSkillStatus } from "@/lib/db/skills"
import { listTeams } from "@/lib/db/teams"
import { getDb } from "@/lib/db/schema"
import type { Character, Skill, Team } from "@/lib/claude/types"
import type { TwinDraft } from "@/types/twin"

type DiscoverTab = "characters" | "teams" | "skills" | "plugins" | "twinDrafts"

const TAB_IDS: DiscoverTab[] = ["characters", "teams", "skills", "plugins", "twinDrafts"]

export default function DiscoverPage() {
  const t = useTranslations("mobile.discover")
  const [tab, setTab] = useState<DiscoverTab>("characters")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null)
  const [query, setQuery] = useState("")

  const characters = useLiveQuery<Character[]>(() => listCharacters(), []) ?? []
  const teams = useLiveQuery<Team[]>(() => listTeams(), []) ?? []
  const skills = useLiveQuery<Skill[]>(() => listSkills(), []) ?? []
  const twinDrafts =
    useLiveQuery<TwinDraft[]>(
      // `createdAt` is not a Dexie index on twinDrafts (see lib/db/schema.ts),
      // so use sortBy() — in-memory sort that does not require an index — and
      // reverse the resulting array for newest-first.
      () =>
        getDb()
          .twinDrafts.toCollection()
          .sortBy("createdAt")
          .then((arr) => arr.reverse() as TwinDraft[]),
      []
    ) ?? []

  const trimmed = query.trim().toLowerCase()
  const matches = (text: string | undefined): boolean =>
    trimmed.length === 0 || (text ?? "").toLowerCase().includes(trimmed)

  const sortedCharacters = useMemo(
    () =>
      characters
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((c) => matches(c.name) || matches(c.description)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [characters, trimmed]
  )
  const sortedTeams = useMemo(
    () =>
      teams
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((tm) => matches(tm.name) || matches(tm.description)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teams, trimmed]
  )
  const sortedSkills = useMemo(
    () =>
      skills
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((s) => matches(s.name) || matches(s.description)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, trimmed]
  )

  const featured = useMemo(
    () =>
      characters
        .filter((c) => c.isBuiltIn)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [characters]
  )

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background safe-area-pt"
      data-testid="discover-page"
    >
      <header className="flex flex-col gap-3 px-4 py-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <DiscoverSearch value={query} onChange={setQuery} />
      </header>

      {tab === "characters" && trimmed.length === 0 ? (
        <FeaturedCarousel
          characters={featured}
          onSelect={(c) => {
            setEditingCharacter(c)
            setEditorOpen(true)
          }}
          className="pb-2"
        />
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as DiscoverTab)}
        className="flex flex-1 flex-col"
      >
        <TabsList className="mx-4 mb-3 grid grid-cols-5">
          {TAB_IDS.map((id) => (
            <TabsTrigger key={id} value={id} data-testid={`discover-tab-${id}`}>
              {t(`tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="characters" className="flex-1 overflow-y-auto px-4 pb-24">
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
          {sortedCharacters.length === 0 ? (
            <EmptyState
              icon={CompassIcon}
              title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptyCharacters")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedCharacters.map((c) => (
                <li key={c.id}>
                  <CharacterCard
                    character={c}
                    onSelect={(picked) => {
                      setEditingCharacter(picked)
                      setEditorOpen(true)
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="teams" className="flex-1 overflow-y-auto px-4 pb-6">
          {sortedTeams.length === 0 ? (
            <EmptyState
              icon={CompassIcon}
              title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptyTeams")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedTeams.map((tm) => (
                <li key={tm.id}>
                  <TeamCard team={tm} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="skills" className="flex-1 overflow-y-auto px-4 pb-6">
          {sortedSkills.length === 0 ? (
            <EmptyState
              icon={CompassIcon}
              title={trimmed.length > 0 ? t("emptyFiltered", { query }) : t("emptySkills")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedSkills.map((s) => (
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
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="plugins" className="flex-1 overflow-y-auto px-4 pb-6">
          <PluginsPanel />
        </TabsContent>

        <TabsContent value="twinDrafts" className="flex-1 overflow-y-auto px-4 pb-6">
          <TwinSourcesPanel />
          <hr className="my-4 border-border" />
          {twinDrafts.length === 0 ? (
            <EmptyState icon={CompassIcon} title={t("emptyTwinDrafts")} />
          ) : (
            <TwinDraftsPanel />
          )}
        </TabsContent>
      </Tabs>

      <CharacterDetailSheet
        open={editorOpen}
        character={editingCharacter}
        onOpenChange={(next) => {
          setEditorOpen(next)
          if (!next) setEditingCharacter(null)
        }}
      />
    </main>
  )
}
