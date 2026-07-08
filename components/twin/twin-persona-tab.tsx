"use client"

/**
 * Persona — the workbench's view onto the distilled twinProfile. Lets the user
 * inspect, edit, pin, or delete the structured persona dimensions (entities,
 * playbooks, style samples) that the distill orchestrator builds from raw
 * chunks. Manual additions land here too.
 *
 * Three sub-tabs share a header counter row showing how many of each kind
 * the profile currently holds — same numbers Settings shows in aggregate.
 *
 * Pinned rows survive `enqueueDistillJob` re-runs (see
 * `lib/db/twin-profile.ts:upsertEntities` honoring `pinned`).
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { getTwinProfile } from "@/lib/db/twin-profile"
import type { TwinProfile } from "@/types/twin"
import { EntitiesSubtab } from "./persona/entities-subtab"
import { PlaybooksSubtab } from "./persona/playbooks-subtab"
import { StyleSamplesSubtab } from "./persona/style-samples-subtab"
import { TwinPersonaPluginSlot } from "./twin-plugin-slots"

type SubTab = "entities" | "playbooks" | "style"

const EMPTY_PROFILE: TwinProfile = {
  id: "",
  twinId: "",
  styleSamples: [],
  playbooks: [],
  entities: [],
  decisions: [],
  voiceSummary: "",
  updatedAt: 0,
}

export function TwinPersonaTab({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.persona")
  const [sub, setSub] = useState<SubTab>("entities")
  // Live-query the profile; treat both "loading" and "no row yet" as an empty
  // profile so the subtabs always mount. CRUD helpers call `ensureTwinProfile`
  // on first write, so "+ Add" works even before a distill has run.
  const profile = useLiveQuery(() => getTwinProfile(twinId), [twinId], undefined)
  const safeProfile: TwinProfile = profile ?? { ...EMPTY_PROFILE, id: twinId, twinId }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{t("title")}</h2>
        <Badge variant="outline" data-testid="persona-count-entities">
          {t("countEntities", { count: safeProfile.entities.length })}
        </Badge>
        <Badge variant="outline" data-testid="persona-count-playbooks">
          {t("countPlaybooks", { count: safeProfile.playbooks.length })}
        </Badge>
        <Badge variant="outline" data-testid="persona-count-style">
          {t("countStyleSamples", { count: safeProfile.styleSamples.length })}
        </Badge>
      </header>

      <Tabs value={sub} onValueChange={(v) => setSub(v as SubTab)} className="flex flex-col gap-3">
        <TabsList className="w-max">
          <TabsTrigger value="entities">{t("tabs.entities")}</TabsTrigger>
          <TabsTrigger value="playbooks">{t("tabs.playbooks")}</TabsTrigger>
          <TabsTrigger value="style">{t("tabs.styleSamples")}</TabsTrigger>
        </TabsList>

        <TabsContent value="entities">
          <EntitiesSubtab twinId={twinId} entities={safeProfile.entities} />
        </TabsContent>
        <TabsContent value="playbooks">
          <PlaybooksSubtab twinId={twinId} playbooks={safeProfile.playbooks} />
        </TabsContent>
        <TabsContent value="style">
          <StyleSamplesSubtab twinId={twinId} styleSamples={safeProfile.styleSamples} />
        </TabsContent>
      </Tabs>

      <TwinPersonaPluginSlot
        twinId={twinId}
        entityCount={safeProfile.entities.length}
        playbookCount={safeProfile.playbooks.length}
        styleCount={safeProfile.styleSamples.length}
      />
    </div>
  )
}
