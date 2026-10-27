"use client"

/**
 * Assembles the RunConfigDialog's target catalogs: models from the user's
 * provider settings (same source as the composer picker), characters / teams /
 * workflows from their Dexie CRUD modules via useLiveQuery; executable Squads
 * come from the Agent Team store used by the evaluation runtime. Closes the v69 gap
 * where the dialog's `options` prop existed but no parent ever populated it.
 */

import { useCallback, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { buildConfiguredRunDeps } from "@/lib/ai/eval/browser-deps"
import { runEvalService, type RunEvalServiceInput } from "@/lib/ai/eval/service"
import { resolveEvalSettings } from "@/lib/ai/eval/settings"
import { collectModelOptions } from "@/lib/ai/model-options"
import { listCharacters } from "@/lib/db/characters"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { listWorkflowsByUpdated } from "@/lib/db/workflows"
import { listTwins } from "@/lib/db/twins"

interface NameId {
  id: string
  name: string
}
export interface RunConfigOptions {
  models?: string[]
  characters?: NameId[]
  teams?: NameId[]
  workflows?: NameId[]
  twins?: NameId[]
}

const EMPTY: { id: string; name: string }[] = []

export function useRunConfigOptions(): RunConfigOptions {
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const squads = useAgentTeamStore((state) => state.teams)
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
  const teams = useMemo(
    () => Object.values(squads).map((squad) => ({ id: squad.id, name: squad.name })),
    [squads]
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

/** Keep host credentials and execution wiring out of the run configuration UI. */
export function useEvalRunConfiguration() {
  const appSettings = useSettingsStore((state) => state.settings)
  const evalSettings = useMemo(() => resolveEvalSettings(appSettings), [appSettings])
  const executionOptions = useMemo(
    () => ({
      appSettings,
      ...(evalSettings.deterministicOnly ? { forceDeterministic: true } : {}),
      ...(evalSettings.judgeModel ? { judgeModel: evalSettings.judgeModel } : {}),
    }),
    [appSettings, evalSettings.deterministicOnly, evalSettings.judgeModel]
  )
  const { deterministicOnly } = useMemo(
    () => buildConfiguredRunDeps(executionOptions),
    [executionOptions]
  )
  const run = useCallback(
    (input: Pick<RunEvalServiceInput, "datasetId" | "config" | "signal" | "onProgress">) =>
      runEvalService({ ...input, ...executionOptions }),
    [executionOptions]
  )
  return {
    evalSettings,
    defaultModel: appSettings?.defaultModel ?? "claude-opus-4-8",
    deterministicOnly,
    run,
  }
}
