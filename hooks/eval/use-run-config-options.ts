"use client"

/**
 * Assembles the RunConfigDialog's target catalogs: models from the user's
 * provider settings (same source as the composer picker), characters / teams /
 * workflows from their Dexie CRUD modules via useLiveQuery. Closes the v69 gap
 * where the dialog's `options` prop existed but no parent ever populated it.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { collectModelOptions } from "@/lib/ai/model-options"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { listWorkflowsByUpdated } from "@/lib/db/workflows"
import { listTwins } from "@/lib/db/twins"
import type { RunConfigOptions } from "@/components/eval/run-config-dialog"

const EMPTY: { id: string; name: string }[] = []

export function useRunConfigOptions(): RunConfigOptions {
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const models = useMemo(
    () => [
      ...new Set(collectModelOptions(providerSettings, customProviders).map((o) => o.modelId)),
    ],
    [providerSettings, customProviders]
  )
  const characters = useLiveQuery(
    async () => (await listCharacters()).map((c) => ({ id: c.id, name: c.name })),
    [],
    EMPTY
  )
  const teams = useLiveQuery(
    async () => (await listTeams()).map((t) => ({ id: t.id, name: t.name })),
    [],
    EMPTY
  )
  const workflows = useLiveQuery(
    async () => (await listWorkflowsByUpdated()).map((w) => ({ id: w.id, name: w.name })),
    [],
    EMPTY
  )
  const twins = useLiveQuery(
    async () => (await listTwins()).map((twin) => ({ id: twin.id, name: twin.name })),
    [],
    EMPTY
  )
  return useMemo(
    () => ({ models, characters, teams, workflows, twins }),
    [models, characters, teams, workflows, twins]
  )
}
